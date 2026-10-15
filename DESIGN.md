---
name: CloudOps Agent
description: Assistant-ui starter adapted into a focused CloudOps investigation workspace
colors:
  background: "oklch(1 0 0)"
  foreground: "oklch(0.141 0.005 285.823)"
  primary: "oklch(0.21 0.006 285.885)"
  primary-foreground: "oklch(0.985 0 0)"
  muted: "oklch(0.967 0.001 286.375)"
  muted-foreground: "oklch(0.48 0.016 285.938)"
  border: "oklch(0.92 0.004 286.32)"
  sidebar: "oklch(0.985 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
typography:
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    lineHeight: 1.6
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    letterSpacing: "-0.025em"
rounded:
  control: "8px"
  surface: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
---

# Design System: CloudOps Agent

## Overview

**Creative North Star: "The investigation workspace"**

The user pins the official assistant-ui starter as the visual baseline. Its neutral surfaces, compact collapsible sidebar, centered welcome/composer, unboxed assistant responses, and softly rounded user messages establish the system. This is a replacement for the previous shell, not a recoloring.

Operate mode: AWS operators read results and work through investigations at a desktop or laptop, with mobile access as a secondary path. A light, quiet canvas makes long technical answers and tabular evidence readable under normal office lighting. No decorative imagery is required; live data is the content.

## Colors

Use the upstream zinc-neutral token vocabulary. Dark primary controls sit on white surfaces; sidebar and user messages use a slightly darker neutral layer. Semantic red marks actual failure; completion uses a neutral checkmark. Local mode is a neutral status label, not a false health indicator.

## Typography

One system sans family carries UI and prose, matching the starter's workhorse typography. Use a fixed hierarchy: 24px welcome title, 15px message body, 14px controls, 12px metadata. Monospace is reserved for code, identifiers, and measurements. Prose stays near the starter's 44rem thread width.

## Layout

Copy the official default template's sidebar/inset workspace. The sidebar is approximately 256px, with branding and new-chat at the top, a searchable conversation list, and user/settings controls at the bottom. The header contains a sidebar toggle, current conversation identity, and environment context. No duplicate prominent new-chat buttons.

Empty chat centers a welcome heading and composer with suggested investigations. Existing threads dock the composer at the bottom of the conversation viewport. The composer and messages share the same maximum width. On narrow screens the sidebar becomes an accessible dismissible sheet; tables scroll within their region rather than widening the page.

## Elevation & Depth

Tonal separation and thin borders define the workspace. Use a modest offset shadow only for floating menus/dialogs and the composer where helpful. Do not retain gradient avatars, purple auth backgrounds, blue chat bubbles, or legacy card framing.

## Shapes

Starter-derived controls use compact rounded corners. Composer/user messages use the larger surface radius. Tool activity is a compact disclosure row; expanded structured results and a copyable raw JSON disclosure use the same neutral border and typography, not a separate design system. Raw output remains inspectable even when there is no specialized preview; redaction/truncation notices are explicit.

## Components

Use copied assistant-ui Thread/Composer/Message primitives and source-owned Radix button/tooltip/sidebar patterns. Remove controls for unsupported attachments, voice, edits, and branching rather than implying those features work. Keep copy-answer, send, stop, history rename/delete, settings, and sign-out functional.

Login, configuration, loading, and error states use the same tokens, icon family, fields, buttons, and spacing as chat. Preserve Cognito challenge/password-reset behavior through the existing authenticator without preserving its old visual treatment. Focus indicators and all error states must remain visible.

## Do's and Don'ts

- Do copy from pinned upstream source and document each adaptation.
- Do keep tool outcomes and local persistence limitations truthful.
- Do use semantic HTML, Lucide icons, and a single control vocabulary.
- Do preserve reduced-motion and keyboard navigation.
- Don't inherit old shell CSS merely to save work.
- Don't add ornamental dashboards, fake metrics, or inactive feature buttons.
- Don't convert role restrictions into frontend-only checks.
