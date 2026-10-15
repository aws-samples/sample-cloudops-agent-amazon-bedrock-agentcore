# CloudOps UI media

Captured 2026-10-15 from the implementation in `847dc4b` (test-only origin assertion updated in `417051e`). All media uses the actual React components. The current walkthrough replays an original agent answer; the screenshot gallery uses synthetic fixtures. Temporary capture harnesses are not part of the app or deployed bundle.

## What the media demonstrates

- `cloudops-demo.gif` / `cloudops-demo.mp4`: an uninterrupted replay of a captured billing answer. Submit the original question, then read daily costs, top cost drivers, service-level findings, observations, and follow-up questions. JSON stays collapsed. The GIF holds on the end of the answer for three seconds before looping. There is no mid-recording new-conversation, reopen, or navigation segment.
- `cloudops-demo.png`: desktop cost-chart presentation.
- `cloudops-before.png`: the same synthetic cost question and daily values rendered by the legacy `ChatLayout` from merge-base `ed5ef55`.
- `cloudops-workspace.png`: sidebar, empty thread, composer, and admin suggestions.
- `cloudops-resources.png`: two synthetic RDS resource rows.
- `cloudops-raw-json.png`: expanded tool output and successful copy feedback.
- `cloudops-mobile.png`: 390px catalogue-restriction presentation. It does **not** establish a Gateway policy denial.
- `cloudops-login.png`: the actual local sign-in page, with credential fields empty.
- `cloudops-settings.png`: the actual settings UI with placeholder connection IDs; no demo-account deployment configuration is published.

## Captured-answer provenance and privacy

The walkthrough's source is the successful user-driven non-admin Cost Explorer request recorded on 2026-10-15, as documented in [agentic-chat-qa.md](../agentic-chat-qa.md). The final assistant text was retrieved read-only from AgentCore Memory and replayed without editorial corrections. Monetary figures are replaced with `[spend masked]` and percentages with `[share masked]`; no account/user/resource IDs, credentials, raw tool payloads, or deployed endpoints are published in the recording.

The on-screen label says **“Agent output replay · spend masked.”** Discovery/tool and partial-answer timing are illustrative replay stages, not the original transport capture or another paid invocation. The original answer has not been fact-checked; its date interpretation and cost-driver ordering illustrate why findings need verification. This media is not proof of deployed streaming, a live chart, authentication, persistence, or policy enforcement.

Screenshot fixtures remain labeled **“UI preview · synthetic data.”** Their chart/resource values are illustrative and separate from the captured answer. Separate local/live-service evidence and open deployment checks are recorded in [agentic-chat-qa.md](../agentic-chat-qa.md).

## Capture and encoding

The native browser recording was explicitly stopped and its saved artifact verified. The source was 1280×900 at nominal 15 FPS; its capture receipt lacks wall-clock frame timing, so this is not an animation-performance benchmark. Both output files were fully decoded to check validity, and the MP4 was inspected through a contact sheet.

- MP4: H.264, yuv420p, fast-start metadata, approximately 20.8 seconds and 527 KiB; a three-second final-frame hold is encoded with `tpad`.
- GIF: 960×675, 8 FPS, 96-color palette, approximately 20.63 seconds and 1.46 MiB; the final frame has an explicitly verified **3.00-second delay** before looping.

The final response was measured inside the visible thread above the sticky composer before capture stopped. The capture receipt confirms one question, collapsed disclosures, and no new-conversation/reopen actions; the contact sheet confirms no reset midway. The pause is deliberate playback pacing, not a backend timing measurement.

Encoding commands (source recording is private scratch output, not required at runtime):

```sh
ffmpeg -i capture.webm -vf 'tpad=stop_mode=clone:stop_duration=3' \
  -an -c:v libx264 -preset medium -crf 24 \
  -pix_fmt yuv420p -movflags +faststart cloudops-demo.mp4
ffmpeg -i capture.webm -filter_complex \
  '[0:v]fps=8,scale=960:-1:flags=lanczos,split[x][y];[x]palettegen=max_colors=96:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle' \
  -loop 0 -final_delay 300 cloudops-demo.gif
```

## Earlier deployed demonstration

The old GIF and screenshot remain in Git history at [`ed5ef55`](https://github.com/aws-samples/sample-cloudops-agent-amazon-bedrock-agentcore/tree/ed5ef5588267f5c479705300793abf2f4521820e/docs/media). They documented a real deployed alarm/history flow on the legacy UI. They are not evidence that the redesigned UI was deployed.
