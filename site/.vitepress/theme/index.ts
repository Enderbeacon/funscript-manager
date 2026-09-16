import DefaultTheme, { VPButton } from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Screenshot from './components/Screenshot.vue'
import FeatureRow from './components/FeatureRow.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Screenshot', Screenshot)
    app.component('FeatureRow', FeatureRow)
    // Its styles are scoped, so markdown pages need the component itself
    // rather than a link wearing its class names.
    app.component('VPButton', VPButton)
  }
} satisfies Theme
