# assistant-ui starter provenance

Baseline copied from [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) revision `325a3cd47a5ea114033879d2da8c66d6749dcf09` on 2026-10-14.

Source-owned components copied before adaptation:

- `templates/minimal/components/assistant-ui/elements/thread.aui.tsx` → `thread.tsx` (centered new-chat composer, docked existing thread, message/action structure).
- `templates/minimal/components/assistant-ui/elements/tooltip-icon-button.tsx` → `tooltip-icon-button.tsx`.
- `packages/ui/src/components/react/assistant-ui/elements/threadlist-sidebar.aui.radix.tsx` → `threadlist-sidebar.tsx`.
- `templates/default/app/assistant.tsx` → workspace composition in `ChatLayout` (sidebar provider/inset/header/thread).
- `templates/default/app/globals.css` → global Tailwind/token foundation.
- `packages/ui/src/components/react/ui/radix/{button,sidebar,tooltip,sheet,separator,input,skeleton}.tsx` → local UI primitives.
- `packages/ui/src/hooks/use-mobile.ts` → local mobile hook.

Adaptations: retain React 18/Vite and the external-store backend rather than Next.js/AI SDK; use Radix consistently; forward button refs for React 18; bind thread history to the existing API; CloudOps branding/suggestions and genuine environment metadata; remove unsupported attachment/voice/edit/branch controls; use validated Tool UI results and existing sanitized Markdown; strengthen readable muted-text contrast and mobile target sizes. These are adapted sources, not an unmodified template or a claim of upstream support.

## MIT License

Copyright (c) 2026 AgentbaseAI Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
