"""Scrape RDS/Aurora EOL dates from AWS docs + supplement with API data."""
import logging
import re
import requests
import boto3
from bs4 import BeautifulSoup
from datetime import datetime

from .. import verification

logger = logging.getLogger(__name__)

DOC_URLS = {
    "rds-mysql": [
        "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/MySQL.Concepts.VersionMgmt.html",
    ],
    "aurora-mysql": [
        "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraMySQLReleaseNotes/AuroraMySQL.release-calendars.html",
    ],
    "rds-postgresql": [
        "https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html",
        "https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-versions.html",
    ],
    "aurora-postgresql": [
        "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/aurorapostgresql-release-calendar.html",
    ],
    "rds-mariadb": [
        "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/MariaDB.Concepts.VersionMgmt.html",
    ],
}


def _extract_date(text: str) -> str:
    text = text.strip().rstrip("*")
    if not text:
        return "Unknown"
    m = re.search(r"\d{4}-\d{2}-\d{2}", text)
    if m:
        return m.group(0)
    for fmt in ["%B %d, %Y", "%b %d, %Y", "%d %B %Y"]:
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # Handle "Month YYYY" format (e.g., "June 2027") → assume 1st of month
    for fmt in ["%B %Y", "%b %Y"]:
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-01")
        except ValueError:
            continue
    return text


def _scrape_major_version_table(url: str, service: str) -> list[dict]:
    """Scrape all version EOL tables from docs (both major and minor versions)."""
    results = []
    try:
        resp = requests.get(url, timeout=30)
        soup = BeautifulSoup(resp.text, "html.parser")
        for table in soup.find_all("table"):
            headers = [th.get_text(strip=True).lower() for th in table.find_all("th")]
            # Relaxed header matching: accept tables with "version" in any header
            # AND at least one column with "end of" or "standard support" or "extended support"
            has_version_col = any("version" in h for h in headers)
            has_eol_col = any(
                "end of" in h or "standard support" in h or "extended support" in h
                for h in headers
            )
            if not (has_version_col and has_eol_col):
                continue
            # Strict matching: require "end of ... support" to avoid catching
            # "RDS start of Extended Support year 1 pricing" columns (which are
            # START dates, not END dates). Those appear in PostgreSQL/Aurora tables.
            idx_std = next((i for i, h in enumerate(headers) if "end of standard support" in h), -1)
            idx_ext = next((i for i, h in enumerate(headers) if "end of extended support" in h), -1)
            # Positional fallback: only apply when BOTH std and ext are missing
            # If only ext is missing, leave it as -1 (will produce "Unknown") rather than
            # duplicating the standard support date
            if idx_std == -1 and idx_ext == -1:
                # Neither column found by name — try positional fallback.
                # Only consider "end of ... support" columns, never "start of" columns.
                eol_indices = [
                    i for i, h in enumerate(headers)
                    if "end of" in h and "support" in h
                ]
                if len(eol_indices) >= 2:
                    idx_std = eol_indices[0]
                    idx_ext = eol_indices[1]
                elif len(eol_indices) == 1:
                    idx_std = eol_indices[0]
                    # Leave idx_ext as -1 — don't duplicate the same column
            elif idx_std == -1 and idx_ext >= 0:
                # Extended found but standard not — try other "end of ... support" columns
                eol_indices = [
                    i for i, h in enumerate(headers)
                    if "end of" in h and "support" in h and i != idx_ext
                ]
                if eol_indices:
                    idx_std = eol_indices[0]
            for tr in table.find_all("tr")[1:]:
                cells = [td.get_text(strip=True) for td in tr.find_all("td")]
                if len(cells) < 3:
                    continue
                # Extract full version (e.g., "10.11.18", "11.8", "8.0")
                m = re.search(r"(\d+(?:\.\d+)*)", cells[0])
                if not m:
                    continue
                results.append({
                    "service": service,
                    "version": m.group(1),
                    "end_of_standard_support": _extract_date(cells[idx_std]) if idx_std >= 0 and idx_std < len(cells) else "Unknown",
                    "end_of_extended_support": _extract_date(cells[idx_ext]) if idx_ext >= 0 and idx_ext < len(cells) else "Unknown",
                    "status": "available",
                    "source": f"docs:{service}",
                })
            # Do NOT break after first table — scrape ALL matching tables on the page
    except Exception as e:
        print(f"  Warning: Failed to scrape {service}: {e}")
    return results


def _fetch_from_api(region: str) -> list[dict]:
    """Get all RDS/Aurora major versions from API with their status (available/deprecated)."""
    client = boto3.client("rds", region_name=region)
    results = []
    for engine, service in [("mysql", "rds-mysql"), ("postgres", "rds-postgresql"),
                             ("aurora-mysql", "aurora-mysql"), ("aurora-postgresql", "aurora-postgresql"),
                             ("mariadb", "rds-mariadb")]:
        try:
            paginator = client.get_paginator("describe_db_engine_versions")
            seen = {}
            for page in paginator.paginate(Engine=engine, IncludeAll=True):
                for v in page["DBEngineVersions"]:
                    major = v["MajorEngineVersion"]
                    if major not in seen:
                        seen[major] = v.get("Status", "available")
                    elif v.get("Status") == "available":
                        seen[major] = "available"
            for major, status in seen.items():
                results.append({
                    "service": service,
                    "version": major,
                    "end_of_standard_support": "Unknown",
                    "end_of_extended_support": "Unknown",
                    "status": status,
                    "source": f"api:rds:{engine}",
                })
        except Exception as e:
            print(f"  Warning: Failed to fetch {engine}: {e}")
    return results


def _verify_scraped_data(service: str, scraped_results: list[dict], api_data: list[dict]) -> list[dict]:
    """Backwards-compatible wrapper around the shared verification module."""
    return verification.verify_service(service, scraped_results, api_data)


def fetch(region: str) -> list[dict]:
    """Combine API data (all versions + status) with scraped EOL dates."""
    # Get all versions from API
    api_data = _fetch_from_api(region)

    # Get EOL dates from docs
    scraped = {}
    for service, urls in DOC_URLS.items():
        service_scraped = []
        for url in urls:
            service_scraped.extend(_scrape_major_version_table(url, service))

        # Runtime verification loop
        try:
            service_scraped = _verify_scraped_data(service, service_scraped, api_data)
        except Exception as e:
            logger.warning(f"Verification failed for {service}: {e}. Proceeding with unverified data.")

        for item in service_scraped:
            scraped.setdefault((item["service"], item["version"]), item)

    # Merge: API versions enriched with scraped dates
    results = []
    for item in api_data:
        key = (item["service"], item["version"])
        if key in scraped:
            item["end_of_standard_support"] = scraped[key]["end_of_standard_support"]
            item["end_of_extended_support"] = scraped[key]["end_of_extended_support"]
            item["source"] = scraped[key]["source"]
        results.append(item)

    # Add any scraped items not found in API
    api_keys = {(r["service"], r["version"]) for r in api_data}
    for key, item in scraped.items():
        if key not in api_keys:
            results.append(item)

    return results
