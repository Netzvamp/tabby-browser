import { Component, Injector, Input, ViewChild, ElementRef, AfterViewInit, OnDestroy, NgZone } from '@angular/core'
import { BaseTabComponent, RecoveryToken, AppService, HotkeysService, SplitTabComponent } from 'tabby-core'
import { Subscription } from 'rxjs'
import type { BrowserWindow, WebContentsView, WebContents, Input as ElectronInput } from 'electron'

const remote = require('@electron/remote')

const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta']

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
    // Parking has three independent sources, each needs its own flag
    private rearranging = false
    private dragging = false
    private resizing = false
    private overlayParked = false
    private forwardedKeys = new Set<string>()
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
        this.watchSpannerDrag()

        if (!this.url && !this.chromeless) {
            this.addressBarInput?.nativeElement.focus()
        }
    }

    get showPrompt (): boolean {
        return this.chromeless && !this.viewCreated
    }

    // Only a pane sharing its tab with others can be closed on its own
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
        this.stopBoundsWatch()
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
        // The next view would otherwise start out parked
        this.rearranging = false
        this.dragging = false
        this.resizing = false
        this.overlayParked = false
        this.forwardedKeys.clear()
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
        // Also drops the address bar out of :focus, see blurOwnInputs()
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
        // Any keyUp still owed is never arriving now
        wc.on('blur', () => this.forwardedKeys.clear())
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

    // The document-level hotkey listener never sees keys while the guest owns the keyboard
    private forwardToHotkeys (event: { preventDefault: () => void }, input: ElectronInput): void {
        if (input.type === 'keyDown') {
            // Plain typing stays on the page, it would trigger single-key hotkeys
            if (!MODIFIER_KEYS.includes(input.key) && !input.control && !input.alt && !input.meta) {
                return
            }
            this.forwardedKeys.add(input.code)
        } else if (input.type === 'keyUp') {
            // Releasing the modifier first leaves the keyUp unmodified, so match what went down
            if (!this.forwardedKeys.delete(input.code)) {
                return
            }
        } else {
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

    private focusView (): void {
        // A parked view delivers no input, including the keyup that ends `rearrange-panes`
        if (this.overlayParked || !this.visible) {
            return
        }
        // SplitTabComponent re-focuses the pane on any click inside it, our toolbar included
        if (this.ownInput()) {
            return
        }
        // focused$ is emitted on every pane of a split, not just the active one
        const parent = this.splitParent
        if (parent && parent.getFocusedTab() !== this) {
            return
        }
        this.view?.webContents.focus()
    }

    // A DOM input keeps `:focus` once the view owns the keyboard, gating hotkey$ off
    private blurOwnInputs (): void {
        this.zone.run(() => this.ownInput()?.blur())
    }

    // Clicks land on the native view, so the split tab's own click handler never fires
    private claimPaneFocus (): void {
        const parent = this.splitParent
        if (!parent || parent.getFocusedTab() === this || this.resizing) {
            return
        }
        this.zone.run(() => parent.focus(this))
    }

    private get splitParent (): SplitTabComponent | null {
        return this.parent instanceof SplitTabComponent ? this.parent : null
    }

    // The spanner drags on mousemove over the pane container, which the view would swallow
    private watchSpannerDrag (): void {
        this.addEventListenerUntilDestroyed(document.documentElement, 'mousedown', (event: Event) => {
            // Parking takes the keyboard, which a background tab has no business doing
            if (!this.visible || !(event.target as Element | null)?.closest?.('split-tab-spanner')) {
                return
            }
            this.resizing = true
            this.syncOverlay()
        }, true)
        this.addEventListenerUntilDestroyed(document.documentElement, 'mouseup', () => {
            if (!this.resizing) {
                return
            }
            this.resizing = false
            this.syncOverlay()
        }, true)
    }

    private syncOverlay (): void {
        const parked = this.rearranging || this.dragging || this.resizing
        if (parked === this.overlayParked) {
            return
        }
        if (parked) {
            // Before parking, or the keyup that ends `rearrange-panes` reaches nobody
            (remote.getCurrentWebContents() as WebContents).focus()
            this.host?.nativeElement.focus()
        }
        this.overlayParked = parked
        this.updateBounds()
        if (!parked) {
            // Nothing hands the keyboard back on its own
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

    // A ResizeObserver misses a pane that moves without resizing
    private startBoundsWatch (): void {
        if (this.boundsWatch) {
            return
        }
        this.zone.runOutsideAngular(() => {
            const tick = () => {
                this.boundsWatch = requestAnimationFrame(tick)
                this.updateBounds()
            }
            this.boundsWatch = requestAnimationFrame(tick)
        })
    }

    private stopBoundsWatch (): void {
        cancelAnimationFrame(this.boundsWatch)
        this.boundsWatch = 0
    }

    private updateBounds (): void {
        if (!this.view || !this.host) {
            return
        }
        const r = this.host.nativeElement.getBoundingClientRect()
        // getZoomFactor() and setBounds are both sync IPC and this runs every frame; a zoom
        // change resizes the CSS viewport, so the rect covers it
        const key = `${r.left} ${r.top} ${r.width} ${r.height} ${this.overlayParked}`
        if (key === this.lastBounds) {
            return
        }
        this.lastBounds = key
        const z = (remote.getCurrentWebContents() as WebContents).getZoomFactor()
        const width = Math.round(r.width * z)
        // Parked, not hidden: it stays attached and keeps reporting key events
        const x = this.overlayParked ? -width - 1000 : Math.round(r.left * z)
        this.view.setBounds({
            x,
            y: Math.round(r.top * z),
            width,
            height: Math.round(r.height * z),
        })
    }

    private setVisible (visible: boolean): void {
        this.visible = visible
        if (visible && this.view) {
            this.startBoundsWatch()
        } else {
            this.stopBoundsWatch()
        }
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
