import { Component, Injector, Input, ViewChild, ElementRef, AfterViewInit, OnDestroy, NgZone } from '@angular/core'
import { BaseTabComponent, RecoveryToken, AppService, HotkeysService, SplitTabComponent } from 'tabby-core'
import { Subscription } from 'rxjs'
import type { BrowserWindow, WebContentsView, WebContents } from 'electron'

const remote = require('@electron/remote')

/** @hidden */
@Component({
    selector: 'browser-tab',
    template: require('./browserTab.component.pug'),
    styles: [require('./browserTab.component.scss')],
})
export class BrowserTabComponent extends BaseTabComponent implements AfterViewInit, OnDestroy {
    @Input() url = ''
    @Input() chromeless = false

    addressBarValue = ''
    promptValue = ''
    viewCreated = false
    loadError: string | null = null

    @ViewChild('host') host!: ElementRef<HTMLElement>
    @ViewChild('addressBar') addressBarInput?: ElementRef<HTMLInputElement>
    @ViewChild('urlPrompt') promptInput?: ElementRef<HTMLInputElement>

    private win?: BrowserWindow
    private view?: WebContentsView
    private boundsWatch = 0
    private lastBounds = ''
    private attached = false
    private visible = false
    // Native views paint above all DOM, so the view has to get out of the way while Tabby
    // draws its pane labels / drop zones. Two independent sources ask for that; a single
    // flag would let one clear the other's request mid-gesture.
    private rearranging = false
    private dragging = false
    private resizing = false
    private overlayParked = false
    private subscriptions: Subscription[] = []

    constructor (injector: Injector, private zone: NgZone, private app: AppService, private hotkeys: HotkeysService) {
        super(injector)
        this.setTitle('Browser')
    }

    ngAfterViewInit (): void {
        this.addressBarValue = this.url

        this.subscriptions.push(this.visibility$.subscribe((visible: boolean) => {
            if (visible && this.url && !this.viewCreated) {
                this.createView()
            }
            this.setVisible(visible)
        }))
        this.subscriptions.push(this.focused$.subscribe(() => this.focusView()))

        this.subscriptions.push(this.hotkeys.hotkey$.subscribe(hk => {
            if (hk === 'rearrange-panes') {
                this.rearranging = true
                this.syncOverlay()
            }
        }))
        this.subscriptions.push(this.hotkeys.hotkeyOff$.subscribe(hk => {
            if (hk === 'rearrange-panes') {
                this.rearranging = false
                this.syncOverlay()
            }
        }))
        this.subscriptions.push(this.app.tabDragActive$.subscribe(tab => {
            this.dragging = !!tab
            this.syncOverlay()
        }))

        if (!this.url && !this.chromeless) {
            this.addressBarInput?.nativeElement.focus()
        }
    }

    get showPrompt (): boolean {
        return this.chromeless && !this.viewCreated
    }

    /** Only a pane sharing its tab with others can be closed on its own */
    get isSplit (): boolean {
        return (this.splitParent?.getAllTabs().length ?? 0) > 1
    }

    closePane (): void {
        this.destroy()
    }

    submitPrompt (): void {
        this.open(this.normalize(this.promptValue))
    }

    navigate (): void {
        this.open(this.normalize(this.addressBarValue))
    }

    goBack (): void {
        this.view?.webContents.goBack()
    }

    goForward (): void {
        this.view?.webContents.goForward()
    }

    reload (): void {
        this.view?.webContents.reload()
    }

    cancel (): void {
        this.destroyView()
        this.loadError = null
        this.viewCreated = false
        this.url = ''
        this.addressBarValue = ''
        this.promptValue = ''
        this.setTitle('Browser')
        this.recoveryStateChangedHint.next()
        // The *ngIf-driven input is (re)rendered this tick; focus it next tick.
        setTimeout(() => {
            const el = this.chromeless ? this.promptInput : this.addressBarInput
            el?.nativeElement.focus()
        })
    }

    async getRecoveryToken (): Promise<RecoveryToken> {
        return {
            type: 'browser-tab',
            url: this.url,
            chromeless: this.chromeless,
        }
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
        this.subscriptions.forEach(s => s.unsubscribe())
        this.subscriptions = []
        this.destroyView()
    }

    private destroyView (): void {
        cancelAnimationFrame(this.boundsWatch)
        this.boundsWatch = 0
        this.lastBounds = ''
        if (this.view && this.attached) {
            try {
                this.win?.contentView.removeChildView(this.view)
            } catch { /* window already gone */ }
            try {
                this.view.webContents.close()
            } catch { /* already closed */ }
        }
        this.attached = false
        this.view = undefined
        this.win = undefined
    }

    private open (value: string): void {
        if (!value) {
            return
        }
        this.url = value
        this.addressBarValue = value
        if (!this.viewCreated) {
            this.createView()
        } else {
            this.view?.webContents.loadURL(value).catch(() => { /* handled via did-fail-load */ })
        }
        // Hand the keyboard to the page, like any browser does on submit. Also gets the
        // address bar out of :focus - see blurOwnInputs().
        this.view?.webContents.focus()
    }

    private normalize (input: string): string {
        let value = (input || '').trim()
        if (value && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            value = `https://${value}`
        }
        return value
    }

    private createView (): void {
        if (this.viewCreated || !this.host) {
            return
        }
        this.win = remote.getCurrentWindow() as BrowserWindow
        const WebContentsView = remote.getBuiltin('WebContentsView')
        this.view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } }) as WebContentsView
        this.win.contentView.addChildView(this.view)
        this.attached = true
        this.viewCreated = true

        const wc: WebContents = this.view.webContents
        wc.on('did-navigate', (_e, url) => this.zone.run(() => this.onNavigated(url)))
        wc.on('did-navigate-in-page', (_e, url) => this.zone.run(() => this.onNavigated(url)))
        wc.on('page-title-updated', (_e, title) => this.zone.run(() => this.setTitle(title || 'Browser')))
        wc.on('did-start-loading', () => this.zone.run(() => this.clearLoadError()))
        wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (errorCode === -3 || !isMainFrame) {
                return
            }
            this.zone.run(() => {
                this.loadError = `Failed to load ${validatedURL || this.url}: ${errorDescription} (${errorCode})`
                this.applyViewVisibility()
            })
        })
        wc.on('before-input-event', (e, input) => {
            if (input.type === 'keyDown') {
                const key = (input.key || '').toLowerCase()
                if (key === 'f5' || ((input.control || input.meta) && key === 'r')) {
                    this.zone.run(() => this.reload())
                    return
                }
            }
            this.forwardToHotkeys(e, input)
        })
        wc.on('focus', () => {
            this.blurOwnInputs()
            this.claimPaneFocus()
        })
        wc.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//i.test(url)) {
                this.app.openNewTab({ type: BrowserTabComponent, inputs: { url } })
            }
            return { action: 'deny' }
        })

        wc.loadURL(this.url).catch(() => { /* handled via did-fail-load */ })

        this.startBoundsWatch()
        this.updateBounds()
    }

    /**
     * The guest WebContents owns the keyboard while focused, so Tabby's document-level
     * hotkey listener never sees these events. Replay them into HotkeysService.
     */
    private forwardToHotkeys (event: { preventDefault: () => void }, input: {
        type: string
        key: string
        code: string
        control: boolean
        alt: boolean
        meta: boolean
        shift: boolean
        isAutoRepeat: boolean
    }): void {
        if (input.type !== 'keyDown' && input.type !== 'keyUp') {
            return
        }
        // Only modified or bare-modifier keystrokes: forwarding plain typing would let text
        // entered on the page trigger single-key hotkeys.
        const isModifierKey = ['Control', 'Shift', 'Alt', 'Meta'].includes(input.key)
        const forwarded = isModifierKey || input.control || input.alt || input.meta
        if (!forwarded) {
            return
        }
        this.hotkeys.pushKeyEvent(input.type === 'keyDown' ? 'keydown' : 'keyup', {
            ctrlKey: input.control,
            metaKey: input.meta,
            altKey: input.alt,
            shiftKey: input.shift,
            key: input.key,
            code: input.code,
            repeat: input.isAutoRepeat,
            timeStamp: performance.now(),
        } as unknown as KeyboardEvent)
        if (this.hotkeys.matchActiveHotkey(true) !== null) {
            event.preventDefault()
        }
    }

    private ownInput (): HTMLInputElement | null {
        const active = document.activeElement
        if (active && (active === this.addressBarInput?.nativeElement || active === this.promptInput?.nativeElement)) {
            return active as HTMLInputElement
        }
        return null
    }

    /**
     * SplitTabComponent re-focuses a pane on *any* click inside it, including our own
     * toolbar, so focusing the view unconditionally would make the address bar
     * un-typeable.
     */
    private focusView (): void {
        // A parked view sits outside the window and delivers no input, so handing it the
        // keyboard black-holes every key event - including the keyup that ends
        // `rearrange-panes`. focused$ fires repeatedly during a drag, so without this the
        // mode can never end.
        if (this.overlayParked) {
            return
        }
        if (this.ownInput() || !this.visible) {
            return
        }
        // SplitTabComponent emits focused$ on *every* pane, not just the active one, so
        // grabbing the keyboard unconditionally makes sibling panes fight over it.
        const parent = this.splitParent
        if (parent && parent.getFocusedTab() !== this) {
            return
        }
        this.view?.webContents.focus()
    }

    /**
     * A DOM input keeps `:focus` even once the native view owns the keyboard, and
     * HotkeysService gates hotkey$ on `input:focus` being empty - a focused address bar
     * swallows every Tabby hotkey, Ctrl+Shift included.
     */
    private blurOwnInputs (): void {
        this.zone.run(() => this.ownInput()?.blur())
    }

    /**
     * Clicks land on the native view, not on the pane's DOM node, so the split tab's own
     * click handler never fires and pane-targeted hotkeys would act on the wrong pane.
     */
    private claimPaneFocus (): void {
        const parent = this.splitParent
        // focus() runs layout(), which rebuilds the spanner components mid-drag
        if (!parent || parent.getFocusedTab() === this || parent._spannerResizing) {
            return
        }
        this.zone.run(() => parent.focus(this))
    }

    private get splitParent (): SplitTabComponent | null {
        return this.parent instanceof SplitTabComponent ? this.parent : null
    }

    private syncOverlay (): void {
        const parked = this.rearranging || this.dragging || this.resizing
        if (parked === this.overlayParked) {
            return
        }
        if (parked) {
            // Take the keyboard off the native view *before* parking it. A parked view
            // stops delivering before-input-event, so if it still holds focus the keyup
            // that ends `rearrange-panes` reaches nobody and the mode latches. The host
            // div is a plain tabindex=-1 target, so it won't trip the `input:focus` gate
            // on hotkey$.
            (remote.getCurrentWebContents() as WebContents).focus()
            this.host?.nativeElement.focus()
        }
        this.overlayParked = parked
        this.updateBounds()
        if (!parked) {
            // Parking costs the view its keyboard focus, and nothing hands it back - the
            // pane goes key-dead until something else focuses it. focusView() re-checks
            // that we're the visible, focused pane.
            this.focusView()
        }
    }

    private onNavigated (url: string): void {
        this.addressBarValue = url
        this.url = url
        this.recoveryStateChangedHint.next()
    }

    private clearLoadError (): void {
        if (this.loadError === null) {
            return
        }
        this.loadError = null
        this.applyViewVisibility()
    }

    /**
     * A ResizeObserver only fires on size changes, so a pane that moves without resizing -
     * dropped into another corner, sibling closed - would leave the native view behind.
     * Poll the rect instead; setBounds is only called when it actually changed.
     */
    private startBoundsWatch (): void {
        this.zone.runOutsideAngular(() => {
            const tick = () => {
                this.boundsWatch = requestAnimationFrame(tick)
                // The spanner drags via mousemove on its DOM parent, which the native view
                // would swallow, and any focus we take mid-drag runs layout() - that drops
                // and rebuilds every spanner component, leaving the in-flight drag holding
                // a detached element. Park for the duration. No observable for this, so
                // piggyback on the frame we're already spending.
                const resizing = this.splitParent?._spannerResizing ?? false
                if (resizing !== this.resizing) {
                    this.resizing = resizing
                    this.syncOverlay()
                }
                this.updateBounds()
            }
            this.boundsWatch = requestAnimationFrame(tick)
        })
    }

    private updateBounds (): void {
        if (!this.view || !this.host) {
            return
        }
        const r = this.host.nativeElement.getBoundingClientRect()
        const z = (remote.getCurrentWebContents() as WebContents).getZoomFactor()
        const width = Math.round(r.width * z)
        // Park the view outside the window rather than hiding it, so it stays attached and
        // keeps reporting key events while it owns the keyboard. Width is kept, so the page
        // sees no resize.
        const x = this.overlayParked ? -width - 1000 : Math.round(r.left * z)
        const bounds = {
            x,
            y: Math.round(r.top * z),
            width,
            height: Math.round(r.height * z),
        }
        // setBounds crosses the remote IPC boundary, so don't send an unchanged rect once
        // per frame.
        const key = JSON.stringify(bounds)
        if (key === this.lastBounds) {
            return
        }
        this.lastBounds = key
        this.view.setBounds(bounds)
    }

    private setVisible (visible: boolean): void {
        this.visible = visible
        this.applyViewVisibility()
    }

    private applyViewVisibility (): void {
        if (!this.view) {
            return
        }
        const show = this.visible && !this.loadError
        this.view.setVisible(show)
        if (show) {
            this.updateBounds()
        }
    }
}
