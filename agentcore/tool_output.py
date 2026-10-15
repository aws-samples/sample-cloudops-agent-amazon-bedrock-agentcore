"""Inspectable tool results, bounded and credential-redacted before leaving the server."""
import json
import math
import re

from authorization_model import is_authorization_denial

MAX_TOOL_OUTPUT = 24_000
MAX_RUN_OUTPUT = 48_000
_SECRET_KEY = re.compile(r'password|passwd|secret|credential|authorization|cookie|privatekey|accesskey|sessiontoken|accesstoken|refreshtoken|idtoken|apikey|signature', re.I)
_SECRET_TEXT = re.compile(
    r'(?i)\bBearer\s+[^\s"\'<>]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|'
    r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|'
    r'-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----|'
    r'((?:password|secret|access[_-]?token|api[_-]?key|x-amz-signature|x-amz-security-token)\s*[=:]\s*)[^\s&,;]+',
)


def inspectable_output(result, limit=MAX_TOOL_OUTPUT):
    """Preserve the tool-result envelope; mark every omission instead of implying completeness."""
    redacted = False
    truncated = False

    def scrub(value, depth=0):
        nonlocal redacted, truncated
        if depth > 12:
            truncated = True
            return '[TRUNCATED: nesting limit]'
        if isinstance(value, dict):
            clean = {}
            for index, (key, child) in enumerate(value.items()):
                if index >= 200:
                    truncated = True
                    clean['_truncated'] = 'Additional fields omitted'
                    break
                name = str(key)
                normalized = re.sub(r'[^a-zA-Z0-9]', '', name)
                if _SECRET_KEY.search(normalized) or normalized.lower() == 'token':
                    clean[name] = '[REDACTED]'
                    redacted = True
                else:
                    clean[name] = scrub(child, depth + 1)
            return clean
        if isinstance(value, (list, tuple)):
            clean = [scrub(child, depth + 1) for child in value[:200]]
            if len(value) > 200:
                truncated = True
                clean.append('[TRUNCATED: additional items omitted]')
            return clean
        if isinstance(value, str):
            # MCP often wraps JSON inside text blocks. Redact within that JSON too.
            if value.lstrip().startswith(('{', '[')) and len(value) > 200_000:
                # Cannot safely inspect credential fields beyond the parsing bound.
                redacted = True
                truncated = True
                return '[OMITTED: JSON text exceeds the safe inspection limit]'
            if value.lstrip().startswith(('{', '[')):
                try:
                    parsed = json.loads(value)
                    clean = scrub(parsed, depth + 1)
                    if clean != parsed:
                        return json.dumps(clean, ensure_ascii=True, separators=(',', ':'))
                except (ValueError, TypeError, RecursionError):
                    pass
            clean, count = _SECRET_TEXT.subn('[REDACTED]', value)
            redacted = redacted or count > 0
            if len(clean) > MAX_TOOL_OUTPUT:
                truncated = True
                clean = clean[:MAX_TOOL_OUTPUT] + '[TRUNCATED]'
            return clean
        if value is None or isinstance(value, (bool, int)):
            return value
        if isinstance(value, float) and math.isfinite(value):
            return value
        # Binary/media and arbitrary Python objects are not JSON data.
        truncated = True
        return '[OMITTED: non-JSON value]'

    if result.get('status') == 'error' and is_authorization_denial(result):
        return {'json': json.dumps({'error': 'Access denied. Restricted tool output is not disclosed.'}),
                'redacted': True, 'truncated': False}
    encoded = json.dumps(scrub(result), ensure_ascii=True, separators=(',', ':'))
    if len(encoded) > limit:
        truncated = True
        # Keep a valid JSON document even when truncation cuts through a text block.
        preview = encoded[:max(0, (limit - 120) // 2)]
        encoded = json.dumps({'_truncated': True, 'preview': preview}, ensure_ascii=True, separators=(',', ':'))
        while len(encoded) > limit and preview:
            preview = preview[:len(preview) // 2]
            encoded = json.dumps({'_truncated': True, 'preview': preview}, ensure_ascii=True, separators=(',', ':'))
    return {'json': encoded, 'redacted': redacted, 'truncated': truncated}
