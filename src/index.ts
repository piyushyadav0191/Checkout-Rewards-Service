import { createApp } from './app'
import { defaultConfig } from './config'

const app = createApp(defaultConfig, { log: true })

export { createApp }
export default app
