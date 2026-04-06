# Design System — Duet

## Product Context
- **What this is:** A personal expertise coach that records meetings, coaches your delivery, and helps you actually become a subject matter expert
- **Who it's for:** Anyone who wants to speak confidently on subjects they don't deeply know. Universal across professionals, creators, students.
- **Space/industry:** Personal coaching / professional development
- **Project type:** Cross-platform desktop app (macOS menubar + Windows taskbar), Tauri v2

## Aesthetic Direction
- **Direction:** Industrial Warmth
- **Decoration level:** Intentional (subtle texture, audio waveforms as visual motif)
- **Mood:** Like a private coaching studio crossed with sports training equipment. Serious personal work done in private. Not corporate training software. Not a playful consumer app. Calm authority with warmth. The app should feel like equipment that respects your time.
- **Visual motif:** Audio waveforms. This is an audio-first app. Waveforms appear in playback controls, transcript views, and progress visualizations. No mascots, no illustrations, no decorative blobs.
- **Reference sites:** Raycast (menubar UX), Duolingo (gamification patterns), Headspace (personal coaching feel)

## Typography
- **Display/Hero:** Satoshi Bold — Geometric but warm. Confident without being cold. Works at large sizes for drill headings and dashboard metrics.
- **Body:** DM Sans — Clean, highly readable at small sizes. Excellent cross-platform rendering (macOS + Windows). Supports tabular-nums for inline data.
- **UI/Labels:** DM Sans Medium
- **Data/Tables:** JetBrains Mono — For confidence scores, filler word counts, timestamps, metrics. Gives the "instrument panel" feel. Reinforces the industrial aesthetic.
- **Code:** JetBrains Mono
- **Loading:** Google Fonts CDN (Satoshi via Fontshare, DM Sans via Google Fonts, JetBrains Mono via Google Fonts)
- **Scale:**
  - 3xl: 36px / 2.25rem (dashboard hero metrics)
  - 2xl: 30px / 1.875rem (page titles)
  - xl: 24px / 1.5rem (section headings)
  - lg: 20px / 1.25rem (card titles)
  - md: 16px / 1rem (body text)
  - sm: 14px / 0.875rem (secondary text, labels)
  - xs: 12px / 0.75rem (captions, metadata)
  - 2xs: 11px / 0.6875rem (micro labels)

## Color
- **Approach:** Restrained (1 accent + warm neutrals, color is rare and meaningful)
- **Primary accent:** #2A7D6E (Deep Teal) — Calm authority. Growth-oriented. Coach energy. Used for primary buttons, active nav states, progress indicators, interactive elements. No competitor in the coaching space uses teal.
- **Primary hover:** #236B5E
- **Primary text-on:** #FFFFFF
- **Neutrals (warm grays, not blue-tinted):**
  - --bg: #FAFAF8 (light) / #1A1A18 (dark)
  - --surface: #FFFFFF (light) / #242422 (dark)
  - --surface-raised: #F5F5F2 (light) / #2E2E2C (dark)
  - --border: #E5E5E0 (light) / #3A3A38 (dark)
  - --text-primary: #1A1A18 (light) / #EBEBEB (dark)
  - --text-secondary: #5A5A52 (light) / #A0A098 (dark)
  - --text-muted: #7A7A72 (light) / #787870 (dark)
- **Semantic:**
  - Success: #3B8C5E
  - Warning: #D4943A
  - Error: #C94040
  - Info: #5B8FBE
- **Dark mode:** Reduce accent saturation by ~10%. Darken surfaces. Keep warm undertone in grays.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable in coaching/study views, tighter in transcript/data views
- **Scale:**
  - 2xs: 2px
  - xs: 4px
  - sm: 8px
  - md: 16px
  - lg: 24px
  - xl: 32px
  - 2xl: 48px
  - 3xl: 64px

## Layout
- **Approach:** Grid-disciplined
- **Structure:** Sidebar navigation (left) + main content area + optional detail panel (right)
- **Menubar popover:** Follows native macOS/Windows patterns. Compact, keyboard-navigable.
- **Grid:** Single column for content, sidebar is fixed-width (220px)
- **Max content width:** 800px for reading/coaching views, full-width for dashboard/data views
- **Border radius:**
  - sm: 4px (inputs, chips, small elements)
  - md: 8px (cards, buttons)
  - lg: 12px (modals, panels)
  - full: 9999px (avatar, toggle, circular buttons)

## Motion
- **Approach:** Minimal-functional
- **Principle:** Transitions that aid comprehension only. Audio playback progress is the primary animation. State transitions between drill steps (REPLAY → COACH → REDO → FEEDBACK) should feel clean and confident.
- **Easing:**
  - Enter: ease-out (elements arriving)
  - Exit: ease-in (elements leaving)
  - Move: ease-in-out (elements changing position)
- **Duration:**
  - Micro: 50-100ms (button hover, focus ring)
  - Short: 150-250ms (panel transitions, dropdown open)
  - Medium: 250-400ms (page transitions, modal entrance)
  - Long: 400-700ms (only for audio waveform animations)
- **No bouncing, no sliding panels, no decorative animation.**

## Component Patterns
- **Audio waveform player:** Primary interactive element. Shows waveform of audio clip with play/pause button. Progress indicated by teal fill over gray waveform. Timestamp in JetBrains Mono.
- **Metric chips:** Small rounded badges showing data points (e.g., "Filler words: 3") in JetBrains Mono on surface-raised background.
- **Practice drill card:** Full-width card with coaching text (DM Sans), waveform player, and prominent RECORD button (teal, full-width at bottom of card).
- **Progress bars:** Teal fill on gray track. Used for transcription progress, topic confidence scores, study completion.
- **Sidebar nav:** Fixed left sidebar. Active state uses teal background with white text. Inactive items in text-secondary.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-05 | Initial design system created | Created by /design-consultation. Industrial warmth aesthetic. |
| 2026-04-05 | Deep Teal (#2A7D6E) chosen over orange, gold, sage | Orange read as danger/warning. Gold too luxury. Sage too passive. Teal has calm authority, coach energy. |
| 2026-04-05 | Variant A layout chosen for Practice Drill | Cleanest layout, best coaching text flow, strong typography hierarchy |
| 2026-04-05 | Audio waveform as visual motif | Duet is an audio-first app. Waveforms reinforce identity and are functional (playback). |
| 2026-04-05 | JetBrains Mono for data | Industrial "instrument panel" feel for metrics, scores, timestamps. Distinctive in coaching app space. |
