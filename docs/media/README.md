# CloudOps UI media

Captured 2026-10-15 from the implementation in `847dc4b` (test-only origin assertion updated in `417051e`). The recording and screenshots use the actual React components; a temporary capture harness supplied illustrative messages and simulated backend events. The harness is not part of the app or deployed bundle.

## What the media demonstrates

- `cloudops-demo.gif` / `cloudops-demo.mp4`: one uninterrupted cost investigation. Enter a question, observe simulated discovery/tool states, inspect a seven-point USD chart and its exact-value table, expand/copy raw JSON, and scroll to the final response. The GIF holds there for three seconds before looping. There is no mid-recording new-conversation, reopen, or navigation segment. This is a presentation fixture, not an authenticated history API demonstration.
- `cloudops-demo.png`: desktop cost-chart presentation.
- `cloudops-before.png`: the same synthetic cost question and daily values rendered by the legacy `ChatLayout` from merge-base `ed5ef55`.
- `cloudops-workspace.png`: sidebar, empty thread, composer, and admin suggestions.
- `cloudops-resources.png`: two synthetic RDS resource rows.
- `cloudops-raw-json.png`: expanded tool output and successful copy feedback.
- `cloudops-mobile.png`: 390px catalogue-restriction presentation. It does **not** establish a Gateway policy denial.
- `cloudops-login.png`: the actual local sign-in page, with credential fields empty.
- `cloudops-settings.png`: the actual settings UI with placeholder connection IDs; no demo-account deployment configuration is published.

All fixture-based captures visibly say **“UI preview · synthetic data.”** They show appearance and interaction, not paid model execution, live cost accuracy, authorization enforcement, or deployed transport parity. Separate local/live-service evidence and open deployment checks are recorded in [agentic-chat-qa.md](../agentic-chat-qa.md).

## Capture and encoding

The native browser recording was explicitly stopped and its saved artifact verified. The source was 1280×900 at nominal 15 FPS; its capture receipt lacks wall-clock frame timing, so this is not an animation-performance benchmark. Both output files were fully decoded to check validity, and the MP4 was inspected through a contact sheet.

- MP4: H.264, yuv420p, fast-start metadata, approximately 12.07 seconds and 161 KiB; a three-second final-frame hold is encoded with `tpad`.
- GIF: 960×675, 8 FPS, 96-color palette, 12 seconds and approximately 531 KiB; the final frame has an explicitly verified **3.00-second delay** before looping.

The final response was measured inside the visible thread above the sticky composer before capture stopped. The capture receipt confirms one question and no new-conversation/reopen actions; the contact sheet confirms no reset midway. The pause is deliberate playback pacing, not a backend timing measurement.

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
