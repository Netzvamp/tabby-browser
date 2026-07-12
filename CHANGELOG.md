# Changelog

## 0.1.0

- Browser tab with address bar (back / forward / reload).
- Web app tab (single page, no browser controls) with an in-tab URL prompt, opened from the left toolbar.
- Tab session recovery (URL + chromeless mode restored on restart).
- Keyboard reload (`F5` / `Ctrl+R` / `Cmd+R`).
- Settings tab (Settings → Browser): homepage, plus toggles to hide the *Open browser* and *Web app* buttons.
- Load-error overlay with Retry / Cancel when a page fails to load (Cancel returns to URL entry, so an unrecoverable page isn't a dead end).
- Links that open a new window (`target="_blank"`, `window.open`) open in a new browser tab.
- Web views are created lazily — restored tabs don't spawn renderers until first shown.
- Rendering via Electron `WebContentsView` overlay (`@electron/remote`), with the page sandboxed and context-isolated.
