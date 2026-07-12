import { Component, Injector, Input, ViewChild, ElementRef, AfterViewInit, OnDestroy, NgZone } from '@angular/core'
import { BaseTabComponent, RecoveryToken, AppService } from 'tabby-core'
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
    private resizeObserver?: ResizeObserver
    private attached = false
    private visible = false
    private subscriptions: Subscription[] = []

    constructor (injector: Injector, private zone: NgZone, private app: AppService) {
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
        this.subscriptions.push(this.focused$.subscribe(() => this.view?.webContents.focus()))

        if (!this.url && !this.chromeless) {
            this.addressBarInput?.nativeElement.focus()
        }
    }

    get showPrompt (): boolean {
        return this.chromeless && !this.viewCreated
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
        this.resizeObserver?.disconnect()
        this.resizeObserver = undefined
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
        wc.on('before-input-event', (_e, input) => {
            if (input.type !== 'keyDown') {
                return
            }
            const key = (input.key || '').toLowerCase()
            if (key === 'f5' || ((input.control || input.meta) && key === 'r')) {
                this.zone.run(() => this.reload())
            }
        })
        wc.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//i.test(url)) {
                this.app.openNewTabRaw({ type: BrowserTabComponent, inputs: { url } })
            }
            return { action: 'deny' }
        })

        wc.loadURL(this.url).catch(() => { /* handled via did-fail-load */ })

        this.resizeObserver = new ResizeObserver(() => this.updateBounds())
        this.resizeObserver.observe(this.host.nativeElement)
        this.updateBounds()
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

    private updateBounds (): void {
        if (!this.view || !this.host) {
            return
        }
        const r = this.host.nativeElement.getBoundingClientRect()
        const z = (remote.getCurrentWebContents() as WebContents).getZoomFactor()
        this.view.setBounds({
            x: Math.round(r.left * z),
            y: Math.round(r.top * z),
            width: Math.round(r.width * z),
            height: Math.round(r.height * z),
        })
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
