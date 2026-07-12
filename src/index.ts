import { Injectable, NgModule, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ToolbarButtonProvider, ToolbarButton, AppService, ConfigService, ConfigProvider, TabRecoveryProvider, RecoveryToken, NewTabParameters, CommandProvider, Command, CommandLocation } from 'tabby-core'

import { BrowserTabComponent } from './browserTab.component'
import { SettingsTabProvider } from 'tabby-settings'
import { BrowserSettingsTabComponent } from './browserSettingsTab.component'

const GLOBE_ICON = '<i class="fas fa-globe" style="font-size:16px"></i>'

/** @hidden */
@Injectable()
export class BrowserConfigProvider extends ConfigProvider {
    defaults = {
        browser: {
            homepage: '',
            showToolbarButton: true,
            showWebAppButton: true,
        },
    }

    platformDefaults = {}
}

/** @hidden */
@Injectable()
export class ButtonProvider extends ToolbarButtonProvider {
    constructor (private app: AppService, private config: ConfigService) {
        super()
    }

    provide (): ToolbarButton[] {
        if (!this.config.store.browser.showToolbarButton) { return [] }
        return [
            {
                icon: GLOBE_ICON,
                title: 'Open browser',
                weight: 5,
                click: () => {
                    this.app.openNewTabRaw({
                        type: BrowserTabComponent,
                        inputs: { url: this.config.store.browser.homepage },
                    })
                },
            },
        ]
    }
}

/** @hidden */
@Injectable()
export class BrowserCommandProvider extends CommandProvider {
    constructor (private app: AppService, private config: ConfigService) {
        super()
    }

    async provide (): Promise<Command[]> {
        if (!this.config.store.browser.showWebAppButton) { return [] }
        return [
            {
                id: 'tabby-browser:new-web-app',
                label: 'Web app',
                // LeftToolbar puts it next to "New terminal" / "Profiles & connections"
                locations: [CommandLocation.LeftToolbar],
                icon: GLOBE_ICON,
                weight: 10,
                run: async () => {
                    this.app.openNewTabRaw({
                        type: BrowserTabComponent,
                        inputs: { chromeless: true },
                    })
                },
            },
        ]
    }
}

/** @hidden */
@Injectable()
export class RecoveryProvider extends TabRecoveryProvider<BrowserTabComponent> {
    async applicableTo (token: RecoveryToken): Promise<boolean> {
        return token.type === 'browser-tab'
    }

    async recover (token: RecoveryToken): Promise<NewTabParameters<BrowserTabComponent>> {
        return {
            type: BrowserTabComponent,
            inputs: {
                url: token.url,
                chromeless: token.chromeless,
            },
        }
    }
}

/** @hidden */
@Injectable()
export class BrowserSettingsTabProvider extends SettingsTabProvider {
    id = 'browser'
    icon = 'globe'
    title = 'Browser'

    getComponentType (): any {
        return BrowserSettingsTabComponent
    }
}

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        { provide: ToolbarButtonProvider, useClass: ButtonProvider, multi: true },
        { provide: CommandProvider, useClass: BrowserCommandProvider, multi: true },
        { provide: TabRecoveryProvider, useClass: RecoveryProvider, multi: true },
        { provide: ConfigProvider, useClass: BrowserConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: BrowserSettingsTabProvider, multi: true },
    ],
    declarations: [
        BrowserTabComponent,
        BrowserSettingsTabComponent,
    ],
    entryComponents: [
        BrowserTabComponent,
        BrowserSettingsTabComponent,
    ],
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export default class BrowserModule {
}

export { BrowserTabComponent }
