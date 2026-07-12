# tabby-browser

A [Tabby](https://github.com/Eugeny/tabby) plugin that adds a web browser tab, so you can keep docs, dashboards, or a web app right next to your terminals.

Rendering uses an Electron `WebContentsView` overlaid on the tab (created via `@electron/remote`), rather than a `<webview>` tag — Tabby ships with `webviewTag` disabled, so the overlay approach is what actually works.

## Features

- **Browser tab with an address bar** — back / forward / reload buttons and a URL bar.
- **Web app tab** — a single page without browser controls; prompts for a URL, then fills the tab. Restored on restart like a terminal. Opened from a button next to *New terminal* / *Profiles & connections*.
- **Session recovery** — open browser tabs are saved and restored on restart, just like terminals (each remembers its URL and chromeless mode).
- **Keyboard reload** — `F5` / `Ctrl+R` / `Cmd+R` reload the page (works in the chromeless tab too).
- **Settings** — Settings → Browser: set a homepage and toggle visibility of the *Open browser* / *Web app* buttons.
- Links that open a new window (`target="_blank"`, `window.open`) open in a new browser tab.

## Install

### Plugin Manager (recommended)

Open Tabby → **Settings → Plugins**, search for **`tabby-browser`**, and click **Install**. Restart Tabby when prompted.

### npm (manual)

Install into Tabby's plugin directory and restart Tabby:

```bash
cd ~/.config/tabby/plugins
npm install tabby-browser
```

On Windows the path is `%APPDATA%\tabby\plugins`, on macOS `~/Library/Application Support/tabby/plugins`.

### From source

```bash
git clone https://github.com/karolnowacki/tabby-browser.git
cd tabby-browser
npm install
npm run build
```

Then link the built plugin into Tabby's plugin directory and restart Tabby:

```bash
mkdir -p ~/.config/tabby/plugins/node_modules
ln -s "$PWD" ~/.config/tabby/plugins/node_modules/tabby-browser
```

## Usage

- Toolbar globe button → browser tab **with** an address bar.
- *Web app* button (by *New terminal*) → single-page tab without browser controls; type a URL and hit *Go*.
- `F5` / `Ctrl+R` / `Cmd+R` → reload the current page.

## Development

```bash
npm run watch   # rebuild on change; reload the Tabby window to pick up changes
```

Reload the Tabby window with `location.reload()` in DevTools (`Ctrl+Shift+I`), or restart Tabby.

## Requirements & notes

- Tabby ≥ 1.0.2xx (built and tested against `tabby-core` `1.0.231-nightly`).
- Relies on Tabby's renderer having `nodeIntegration` + `@electron/remote` available (the default), and Electron ≥ 30 for `WebContentsView`.
- The web view is a native layer painted over the tab; it's hidden automatically when you switch away from the tab.
- Because the `WebContentsView` is a native layer painted over the tab, Tabby's own modal dialogs (settings, command palette, profile selector) may appear beneath the page while a browser tab is active — switch away from the browser tab to interact with them.

## Contributing

Issues and PRs welcome: https://github.com/karolnowacki/tabby-browser/issues

## License

[MIT](./LICENSE) © Karol Nowacki