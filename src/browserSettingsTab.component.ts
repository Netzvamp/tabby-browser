import { Component } from '@angular/core'
import { ConfigService } from 'tabby-core'

/** @hidden */
@Component({
    template: require('./browserSettingsTab.component.pug'),
})
export class BrowserSettingsTabComponent {
    constructor (public config: ConfigService) {}
}
