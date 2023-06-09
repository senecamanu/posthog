import * as Sentry from '@sentry/node'
import * as nodeSchedule from 'node-schedule'

import { startGraphileWorker } from '../src/main/graphile-worker/worker-setup'
import { ServerInstance, startPluginsServer } from '../src/main/pluginsServer'
import { LogLevel, PluginServerCapabilities, PluginsServerConfig } from '../src/types'
import { killProcess } from '../src/utils/kill'
import { makePiscina } from '../src/worker/piscina'
import { resetTestDatabase } from './helpers/sql'

jest.mock('../src/utils/kill')
jest.mock('../src/main/graphile-worker/schedule')
jest.mock('../src/main/graphile-worker/worker-setup')
jest.setTimeout(60000) // 60 sec timeout

function numberOfScheduledJobs() {
    return Object.keys(nodeSchedule.scheduledJobs).length
}

describe('server', () => {
    let pluginsServer: ServerInstance | null = null

    function createPluginServer(
        config: Partial<PluginsServerConfig> = {},
        capabilities: PluginServerCapabilities | undefined = undefined
    ) {
        return startPluginsServer(
            {
                WORKER_CONCURRENCY: 2,
                LOG_LEVEL: LogLevel.Debug,
                ...config,
            },
            makePiscina,
            capabilities
        )
    }

    beforeEach(() => {
        jest.spyOn(Sentry, 'captureMessage')

        jest.useFakeTimers({ advanceTimers: true })
    })

    afterEach(async () => {
        await pluginsServer?.stop()
        pluginsServer = null
        jest.runAllTimers()
        jest.useRealTimers()
    })

    test('startPluginsServer does not error', async () => {
        const testCode = `
        async function processEvent (event) {
            return event
        }
    `
        await resetTestDatabase(testCode)
        pluginsServer = await createPluginServer()
    })

    describe('plugin server staleness check', () => {
        test('test if the server terminates', async () => {
            const testCode = `
            async function processEvent (event) {
                return event
            }
        `
            await resetTestDatabase(testCode)

            pluginsServer = await createPluginServer({
                STALENESS_RESTART_SECONDS: 5,
            })

            jest.advanceTimersByTime(10000)

            expect(killProcess).toHaveBeenCalled()

            expect(Sentry.captureMessage).toHaveBeenCalledWith(
                `Plugin Server has not ingested events for over 5 seconds! Rebooting.`,
                {
                    extra: {
                        instanceId: expect.any(String),
                        lastActivity: expect.any(String),
                        lastActivityType: 'serverStart',
                        isServerStale: true,
                        timeSinceLastActivity: expect.any(Number),
                    },
                }
            )
        })
    })

    test('starting and stopping node-schedule scheduled jobs', async () => {
        expect(numberOfScheduledJobs()).toEqual(0)

        pluginsServer = await createPluginServer()

        expect(numberOfScheduledJobs()).toBeGreaterThan(1)

        await pluginsServer.stop()
        pluginsServer = null

        expect(numberOfScheduledJobs()).toEqual(0)
    })

    describe('plugin-server capabilities', () => {
        test('starts all main services by default', async () => {
            pluginsServer = await createPluginServer()

            expect(startGraphileWorker).toHaveBeenCalled()
        })

        test('disabling pluginScheduledTasks', async () => {
            pluginsServer = await createPluginServer(
                {},
                { ingestion: true, pluginScheduledTasks: false, processPluginJobs: true }
            )

            expect(startGraphileWorker).toHaveBeenCalled()
        })

        test('disabling processPluginJobs', async () => {
            pluginsServer = await createPluginServer(
                {},
                { ingestion: true, pluginScheduledTasks: true, processPluginJobs: false }
            )

            expect(startGraphileWorker).toHaveBeenCalled()
        })

        test('disabling processPluginJobs, ingestion, and pluginScheduledTasks', async () => {
            pluginsServer = await createPluginServer(
                {},
                { ingestion: false, pluginScheduledTasks: false, processPluginJobs: false }
            )

            expect(startGraphileWorker).not.toHaveBeenCalled()
        })
    })
})
