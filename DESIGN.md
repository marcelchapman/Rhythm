---
name: Rhythm
description: A personal music library with an artwork-led desktop workspace.
colors:
  primary: "#85c3ff"
  selected: "#2a4569"
  focus: "#9bcdff"
  action: "#365e8b"
  action-hover: "#436fa0"
  range: "#6caeff"
  danger: "#85424b"
  background: "#101720"
  surface: "#111923"
  panel: "#131b26"
  text: "#f3f5f8"
  muted: "#b4bac7"
  line: "#ffffff0c"
  hover: "#ffffff08"
  quiet: "#ffffff07"
  quiet-hover: "#ffffff0d"
  modal: "#1a2533"
  field: "#101923"
  notice: "#213248"
  notice-text: "#c4e2ff"
  error: "#422d35"
  error-text: "#ffe1df"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  section-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
  track:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  action:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 500
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  metadata:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  artwork: "5px"
  control: "6px"
  navigation: "7px"
  card: "8px"
  search: "9px"
  dialog: "12px"
  circle: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  control: "10px"
  md: "12px"
  item: "14px"
  lg: "16px"
  section: "20px"
  panel: "22px"
  card: "24px"
  workspace: "26px"
  page-bottom: "32px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "#fff"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-quiet:
    backgroundColor: "{colors.quiet}"
    textColor: "#e0e7f2"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  button-quiet-hover:
    backgroundColor: "{colors.quiet-hover}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#fff"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  button-icon:
    textColor: "#e4e8ef"
    rounded: "{rounded.circle}"
    size: "32px"
  input-search:
    backgroundColor: "#ffffff09"
    textColor: "{colors.muted}"
    rounded: "{rounded.search}"
    height: "36px"
    padding: "0 12px"
  nav-item:
    rounded: "{rounded.navigation}"
    padding: "10px 16px"
  nav-item-selected:
    backgroundColor: "{colors.selected}"
    rounded: "{rounded.navigation}"
  album-artwork:
    backgroundColor: "#1c293b"
    rounded: "{rounded.artwork}"
    width: "100%"
  playlist-card:
    backgroundColor: "#ffffff04"
    rounded: "{rounded.card}"
    padding: "24px"
  dialog:
    backgroundColor: "{colors.modal}"
    rounded: "{rounded.dialog}"
    padding: "26px"
    width: "520px"
---
# Design System: Rhythm

## Overview

**Creative North Star: "The personal music library"**

Rhythm uses the user-approved desktop prototype as its visual authority: a navy and charcoal workspace in which album artwork leads and controls remain restrained. White titles, muted metadata, thin dividers, and blue state cues keep a dense personal collection readable.

This record describes the implemented desktop app in src/renderer/style.css and src/renderer/App.tsx. It captures reusable visual behavior rather than extending the identity to future mobile or marketing surfaces.

**Key Characteristics:**

- Artwork leads the library view.
- Persistent navigation, contextual album details or queue, and playback share one desktop shell.
- Blue identifies selection, playback state, focus, and primary actions.
- Compact system typography and tonal separation support everyday library tasks.

## Colors

The palette is a quiet navy and charcoal ground with cool white text and restrained blue interaction cues. The frontmatter contains the normative values extracted from the implementation.

### Primary

- **Library blue** (`primary`): active icon controls, selected artwork outlines, and the brand mark.
- **Selected blue** (`selected`): the filled active navigation row.
- **Focus blue** (`focus`): the visible keyboard outline.
- **Action blue** (`action`, `action-hover`): primary text buttons and their hover state.
- **Playback blue** (`range`): seek and volume progress and slider thumbs.

### Secondary

- **Destructive rose** (`danger`): the explicit destructive confirmation button. This is a semantic action color rather than a decorative second accent.
- **Error rose** (`error`, `error-text`): error notices and their readable foreground.

### Neutral

- **Deep navy** (`background`, `surface`, `panel`): the dark workspace foundation and its surface vocabulary. The shell uses a subtle navy gradient; the right panel shares that shell rather than adding an opaque card.
- **Cool white** (`text`): primary text. Hovered controls and primary button labels can use pure white.
- **Muted silver** (`muted`): artists, durations, navigation group labels, and supporting copy.
- **Transparent white layers** (`line`, `hover`, `quiet`, `quiet-hover`): separators and quiet interaction states.
- **Dialog navy** (`modal`, `field`): an elevated dialog body and its inset text input.
- **Notice blue** (`notice`, `notice-text`): scan progress and import summaries.

**The State Color Rule.** Use blue for selected navigation, selected artwork, current playback, active controls, and keyboard focus; let the collection supply the broad color variation.

## Typography

**Body and interface font:** the platform system sans stack recorded in the frontmatter. The same family serves headings, navigation, labels, and data; there is no separate promotional display face.

**Character:** compact, familiar, and readable. Hierarchy comes from size, weight, spacing, and text color rather than multiple type families.

### Hierarchy

- **Headline:** the larger first-run and empty-library title, using the `headline` role.
- **Title:** library section headings, album detail titles, and dialog titles, using `title`.
- **Section title:** setup steps and small subheadings, using `section-title`.
- **Body:** default navigation and interface copy, using `body`.
- **Track:** full track-list titles, using `track`; compact queue titles use the smaller metadata scale.
- **Action:** primary, quiet, and destructive text buttons, using `action`.
- **Label / metadata:** album captions, artists, supporting navigation, and durations, using `label` and `metadata`. Fine print is smaller (11px); seek timestamps are smaller again (10px).

Track durations, track numbers, and playback time use tabular numerals. Long album captions and track rows truncate with an ellipsis; album detail titles can wrap. First-run body copy has a more open line height (1.8).

## Layout

The implemented desktop shell has three columns: navigation (230px), a flexible library workspace with a minimum width (400px), and a contextual details or queue panel (310px). The persistent player spans all columns in a lower row (90px). The sidebar, library content, and detail panel scroll independently; the toolbar stays within the upper workspace.

The workspace toolbar is compact (64px high). Library content uses lateral padding (26px) and bottom padding (32px). A full desktop album view has five equal columns, with a row gap (26px) and column gap (22px). Artwork is square and captions sit below it; cards have no enclosing surface. Recently added and the main collection use the same artwork grammar.

At a maximum viewport width (1250px), navigation and details narrow (200px / 270px), the album grid becomes four columns, and the fifth recent item is hidden. At a maximum width (1050px), the outer columns narrow again (182px / 250px), the center minimum becomes (380px), the album grid becomes three columns, and the fourth recent item is hidden. The smaller desktop treatment removes history controls and list album metadata to preserve working space. These are desktop adaptations, not a mobile layout.

The player separates current track, transport, and tools into three zones (30% / 40% / 30% at full width; 32% / 40% / 28% below the first breakpoint). The main play control stays centered over the seek control. The common spacing vocabulary is in the frontmatter; local measured gaps are not a universal mathematical scale.

## Elevation & Depth

The interface is predominantly flat. A subtle shell gradient, translucent sidebar and player layers, thin dividers, and quiet hover fills distinguish regions. Selected navigation and the central play button have fine inset borders. Album cards do not acquire cast shadows or movement on hover.

### Shadow Vocabulary

- **Dialog:** `0 18px 70px #0008`; a large cast shadow beneath the modal, over a dark scrim (`#02060bbf`).
- **Selected navigation:** `inset 0 0 0 1px #5078a528`; a fine edge within the blue fill.
- **Transport play:** `inset 0 0 0 1px #7da5d140`; a fine edge within the blue gradient control.

**The Tonal Separation Rule.** Separate the library regions with dark surface tones and thin translucent dividers. Reserve the large cast shadow for modal dialogs.

## Shapes

Artwork and track rows have lightly softened corners; text actions and fields are gently rounded; navigation rows are slightly softer again. The frontmatter records the existing radii rather than forcing a new shared value. Icon actions, play controls, slider thumbs, and setup numbers are circular. Dialogs have the largest corner radius. Thin strokes and dividers provide boundaries without surrounding every item in a box.

## Components

### Buttons

Text actions are compact and restrained. Primary actions use action blue and white labels; quiet actions use a translucent white fill and cool white labels; destructive confirmation uses rose. They share modest rounding, icon gaps (8px), and padding (10px 14px). Primary and quiet variants brighten on hover. Icon buttons are circular (32px) with line SVG icons (19px). Active icon controls use library blue. Disabled buttons reduce opacity (.38).

Keyboard focus uses an outline (2px) with an offset (3px). Button background and text changes transition over (.14s ease). The central transport play button is larger (44px), with a blue gradient (`#426692` to `#2b4668`) and a brighter hover fill (`#456c9e`).

### Cards / Containers

Album cards are artwork plus a two-line caption with no outer fill. The selected cover has a library-blue outline (2px, offset 3px). Hover or keyboard focus reveals the dark translucent album hint; hover or focus within reveals the circular play action. Those reveals use opacity transitions (.15s). Artwork is cropped with `object-fit: cover`. Missing artwork uses the shipped navy gradient and a thin disc SVG, not generated album content.

Playlist cards use a very subtle translucent fill, larger padding, and a softly rounded boundary. The create-playlist card uses a dashed outline. Dialogs use dialog navy, a constrained width (520px), internal padding (26px), and scrolling at a maximum height (85vh).

### Inputs / Fields

Search is a rounded, translucent field with a leading search SVG and a compact input label. The input flexes with the toolbar. Dialog text fields are inset navy with a thin translucent border, gentle rounding, and padding (12px). All input and select focus states use the shared keyboard outline. The caret uses library blue.

### Navigation

Navigation pairs thin line SVG icons with text in compact full-width rows. The selected item receives selected blue and a fine inset edge; hover receives a quiet translucent fill. Group labels and lower utility navigation use muted text. Long labels truncate instead of widening the sidebar. The sidebar remains present at implemented desktop widths.

### Track Lists and Queue

Full track rows are compact (minimum 62px), with an artwork thumbnail, title/artist, optional album, duration, and actions. Queue and album-detail rows use a denser minimum height (39px), smaller title text, and no row divider. Playing rows use blue text over a subtle blue tint. Hover replaces the row number with a play icon; row actions are also accessible through keyboard focus. Missing tracks use a muted rose text cue.

### Persistent Player

A dark translucent player spans the entire bottom edge. It holds current artwork and title/artist at left, circular transport actions and a thin seek bar in the center, and volume/queue tools at right. Seek and volume share a blue filled track, translucent remaining track, and a circular thumb. Inactive playback controls are visibly disabled when no usable music is available.

### Dialogs and Notices

Dialogs place a title and close action above content and right-aligned actions below. They trap keyboard focus, close on Escape or backdrop interaction, and restore prior focus. Progress/import notices use the notice blue pair; failures use the error pair. First-run and empty-library states keep the shell and player visible, centering a concise title, supporting copy, and an explicit primary action in the workspace.

The loading spinner rotates over (1.1s linear). Reduced-motion preference disables animations and transitions throughout the interface.

## Do's and Don'ts

### Do:

- **Do** preserve the approved desktop prototype as the visual authority.
- **Do** use square album artwork with compact title and artist captions.
- **Do** retain the persistent player while the library workspace scrolls.
- **Do** expose hover actions on keyboard focus as well as pointer hover.
- **Do** honor reduced motion and visible keyboard focus.

### Don't:

- **Don't** use accent-filled backgrounds as decoration across library content.
- **Don't** promote the desktop shell measurements into rules for unimplemented mobile surfaces.
- **Don't** replace real album artwork with a new branded illustration system.
