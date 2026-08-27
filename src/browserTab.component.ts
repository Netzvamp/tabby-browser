import { Component, Injector, Input, ViewChild, ElementRef, AfterViewInit, OnDestroy, NgZone } from '@angular/core'
import { BaseTabComponent, RecoveryToken, AppService, HotkeysService, SplitTabComponent } from 'tabby-core'
import { Subscription } from 'rxjs'
import type { BrowserWindow, WebContentsView, WebContents, Input as ElectronInput } from 'electron'

const remote = require('@electron/remote')

const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta']
const FUNCTION_KEY = /^F\d{1,2}$/
const COVERAGE_INTERVAL = 33

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
    editingUrl = false
    loadError: string | null = null

    @ViewChild('host') host!: ElementRef<HTMLElement>
    @ViewChild('addressBar') addressBarInput?: ElementRef<HTMLInputElement>
    @ViewChild('urlPrompt') promptInput?: ElementRef<HTMLInputElement>

    private win?: BrowserWindow
    private view?: WebContentsView
    private boundsWatch = 0
    private lastCoverageCheck = 0
    private lastBounds = ''
    private attached = false
    private visible = false
    private gestures = new Set<string>()
    private overlayParked = false
    private viewFocused = false
    private claimingPaneFocus = false
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

        this.subscriptions.push(this.hotkeys.hotkey$.subscribe((hk: string) => {
            if (hk === 'rearrange-panes' && this.visible) {
                this.setGesture('rearrange', true)
            }
        }))
        this.subscriptions.push(this.hotkeys.hotkeyOff$.subscribe((hk: string) => {
            if (hk === 'rearrange-panes') {
                this.setGesture('rearrange', false)
            }
        }))
        this.subscriptions.push(this.app.tabDragActive$.subscribe((tab: BaseTabComponent | null) => {
            this.setGesture('drag', !!tab && this.visible)
        }))
        this.watchSpannerDrag()

        if (!this.url && !this.chromeless) {
            this.addressBarInput?.nativeElement.focus()
        }
    }

    get showPrompt (): boolean {
        return this.chromeless && (!this.viewCreated || this.editingUrl)
    }

    get canEditUrl (): boolean {
        return this.chromeless && this.viewCreated && !this.editingUrl && !this.loadError
    }

    get isSplit (): boolean {
        return (this.splitParent?.getAllTabs().length ?? 0) > 1
    }

    closePane (): void {
        this.destroy()
    }

    editUrl (): void {
        this.promptValue = this.url
        this.editingUrl = true
        setTimeout(() => {
            this.promptInput?.nativeElement.focus()
            this.promptInput?.nativeElement.select()
        })
    }

    cancelEdit (): void {
        if (!this.editingUrl) {
            return
        }
        this.editingUrl = false
        this.promptValue = ''
        this.blurOwnInputs()
    }

    submitPrompt (): void {
        const value = this.normalize(this.promptValue)
        if (!value) {
            return
        }
        this.editingUrl = false
        this.open(value)
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
        this.editingUrl = false
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
        this.gestures.clear()
        this.overlayParked = false
        this.viewFocused = false
        this.claimingPaneFocus = false
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
        this.blurOwnInputs()
        this.takeKeyboard()
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
            this.viewFocused = true
            this.blurOwnInputs()
            this.claimPaneFocus()
        })
        wc.on('blur', () => {
            this.viewFocused = false
            this.forwardedKeys.clear()
        })
        wc.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//i.test(url)) {
                this.zone.run(() => this.app.openNewTab({ type: BrowserTabComponent, inputs: { url } }))
            }
            return { action: 'deny' }
        })

        wc.loadURL(this.url).catch(() => { /* handled via did-fail-load */ })

        this.startBoundsWatch()
        this.updateBounds()
    }

    private forwardable (input: ElectronInput): boolean {
        return MODIFIER_KEYS.includes(input.key) || FUNCTION_KEY.test(input.key)
            || input.control || input.alt || input.meta
    }

    private forwardToHotkeys (event: { preventDefault: () => void }, input: ElectronInput): void {
        const isDown = input.type === 'keyDown'
        if (isDown) {
            if (!this.forwardable(input)) {
                return
            }
            this.forwardedKeys.add(input.code)
        } else if (input.type === 'keyUp') {
            if (!this.forwardedKeys.delete(input.code)) {
                return
            }
        } else {
            return
        }
        this.hotkeys.pushKeyEvent(isDown ? 'keydown' : 'keyup', {
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
        if (this.claimingPaneFocus || this.overlayParked || !this.visible || this.ownInput()) {
            return
        }
        const parent = this.splitParent
        if (parent && parent.getFocusedTab() !== this) {
            return
        }
        this.takeKeyboard()
    }

    private takeKeyboard (): void {
        if (this.viewFocused || this.overlayParked) {
            return
        }
        this.view?.webContents.focus()
    }

    private blurOwnInputs (): void {
        this.zone.run(() => this.ownInput()?.blur())
    }

    private claimPaneFocus (): void {
        const parent = this.splitParent
        if (!parent || parent.getFocusedTab() === this || this.gestures.has('resize')) {
            return
        }
        this.claimingPaneFocus = true
        try {
            this.zone.run(() => parent.focus(this))
        } finally {
            this.claimingPaneFocus = false
        }
    }

    private get splitParent (): SplitTabComponent | null {
        return this.parent instanceof SplitTabComponent ? this.parent : null
    }

    private watchSpannerDrag (): void {
        this.addEventListenerUntilDestroyed(document.documentElement, 'mousedown', (event: Event) => {
            if (this.visible && (event.target as Element | null)?.closest?.('split-tab-spanner')) {
                this.setGesture('resize', true)
            }
        }, true)
        this.addEventListenerUntilDestroyed(document.documentElement, 'mouseup', () => {
            this.setGesture('resize', false)
        }, true)
    }

    private setGesture (name: string, active: boolean): void {
        if (active === this.gestures.has(name)) {
            return
        }
        if (active) {
            this.gestures.add(name)
        } else {
            this.gestures.delete(name)
        }
        this.syncOverlay()
    }

    private isCovered (): boolean {
        const host = this.host?.nativeElement
        if (!host || !this.visible || !this.view || this.loadError) {
            return false
        }
        const r = host.getBoundingClientRect()
        if (!r.width || !r.height) {
            return false
        }
        const inset = 2
        const xs = [r.left + inset, r.left + r.width / 2, r.right - inset]
        const ys = [r.top + inset, r.top + r.height / 2, r.bottom - inset]
        for (const x of xs) {
            for (const y of ys) {
                const onTop = document.elementFromPoint(x, y)
                if (onTop && !host.contains(onTop)) {
                    return true
                }
            }
        }
        return false
    }

    private syncOverlay (): void {
        const gesture = this.gestures.size > 0
        const parked = gesture || this.isCovered()
        if (parked === this.overlayParked) {
            return
        }
        if (parked) {
            (remote.getCurrentWebContents() as WebContents).focus()
            if (gesture) {
                this.host?.nativeElement.focus()
            }
        }
        this.overlayParked = parked
        this.updateBounds()
        if (!parked) {
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

    private startBoundsWatch (): void {
        if (this.boundsWatch) {
            return
        }
        this.zone.runOutsideAngular(() => {
            const tick = () => {
                this.boundsWatch = requestAnimationFrame(tick)
                const now = performance.now()
                if (now - this.lastCoverageCheck >= COVERAGE_INTERVAL) {
                    this.lastCoverageCheck = now
                    this.syncOverlay()
                }
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
        const key = `${r.left} ${r.top} ${r.width} ${r.height} ${this.overlayParked}`
        if (key === this.lastBounds) {
            return
        }
        this.lastBounds = key
        const z = (remote.getCurrentWebContents() as WebContents).getZoomFactor()
        const width = Math.round(r.width * z)
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
        this.syncOverlay()
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
