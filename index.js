const jwt = require('jsonwebtoken')
const createStore = require('./store')
const logger = require('pino')({base: null})
const pkg = require('./package.json')

// The livigndocs api, e.g. https://bluewin-server.livingdocs.io
const apiUrl = process.env.API_URL

// How often should we poll the event stream
const eventPollInterval = Math.max(3000, process.env.API_POLL_INTERVAL || 5000)

// Host Header used for requests, e.g. bluewin.livingdocs.io
const frontendHostHeader = process.env.FRONTEND_HOST

// Varnish URL, e.g. http://varnish/
const varnishUrl = process.env.VARNISH_URL

// Whether we should trigger purge calls against all DNS A records behind the hostname
const useMultiHostPurge = process.env.VARNISH_MULTIPURGE === 'true'

const axios = useMultiHostPurge ? require('./request') : require('axios')

// Declare the livingdocs tokens as environment variables
// TOKEN_de
// TOKEN_fr
// TOKEN_it

function initProjects () {
  const varnishRequest = axios.create({
    logger,
    timeout: 120000,
    httpAgent: new (require('http').Agent)({
      keepAlive: true
    }),
    httpsAgent: new (require('https').Agent)({
      keepAlive: true,
      servername: frontendHostHeader
    }),
    baseURL: varnishUrl,
    headers: {'User-Agent': `livingdocs/varnish-purge@${pkg.version}`}
  })

  const projects = []
  for (const key in process.env) {
    const match = /^TOKEN(_.+)?/i.exec(key) && RegExp.$1
    if (match !== null) {
      const decoded = jwt.decode(process.env[key])
      if (!decoded) logger.warn(`Failed to parse token in environment variable '${key}'`)

      projects.push({
        name: decoded.name,
        apiBaseUrl: apiUrl,
        storagePath: process.env.STORAGE_PATH,
        eventPollInterval,
        varnishRequest,
        pathPrefix: (match || '').replace(/[/_]{0,2}/, '/').replace(/\/?$/, '/'),
        projectId: decoded.projectId,
        token: process.env[key],
        log: logger.child({projectId: decoded.projectId, name: decoded.name})
      })
    }
  }
  return projects
}

async function start () {
  const queue = require('./queue')({
    concurrency: 20,
    async process (job) {
      job._tries = job._tries + 1

      const {documentId, _project: project} = job
      if (job.event === 'unpublish') {
        await project.varnishRequest({
          validateStatus (status) { return status < 500 },
          method: 'BAN',
          url: `/ban`,
          headers: {
            Host: frontendHostHeader,
            'X-Cache-Tags': `document=${documentId}`
          }
        })
        project.log.info({documentId}, 'Document unpublished')
        return
      }

      // Get the current url. Attention, axios automatically follows the redirect
      // so we'll get a 200 status code here with the correct path
      const pathRes = await project.varnishRequest({
        onlyOne: true,
        validateStatus: null,
        method: 'HEAD',
        url: `${project.pathPrefix}purge-${documentId}.html`,
        headers: {
          Host: frontendHostHeader,
          Accept: 'text/html'
        }
      })

      // trigger a softpurge
      await project.varnishRequest({
        validateStatus: null,
        method: 'PURGE',
        url: `/softpurge`,
        headers: {
          Host: frontendHostHeader,
          'X-Cache-Tags': `document=${documentId}`
        }
      })

      if (pathRes.status !== 200) {
        return project.log.info(
          {documentId, status: pathRes.status},
          `Document ${job.event}.`,
          `But couldn't trigger a refresh because the url lookup failed.`
        )
      }

      // Trigger a refresh of the other pages
      const url = pathRes.request.path
      await Promise.all([
        // Precache the regular page
        project.varnishRequest({
          validateStatus: null,
          method: 'HEAD',
          url: url,
          headers: {
            Host: frontendHostHeader,
            Accept: 'text/html'
          }
        }),
        // Precache the amp website
        job.documentType === 'article' && project.varnishRequest({
          validateStatus: null,
          method: 'HEAD',
          url: url.replace(/.html$/, '.amp.html'),
          headers: {
            Host: frontendHostHeader,
            Accept: 'text/html'
          }
        }),
        // Precache the bluewin app content
        project.varnishRequest({
          validateStatus: null,
          method: 'HEAD',
          url,
          headers: {
            Host: frontendHostHeader,
            Accept: 'application/json',
            'User-Agent': 'bluewin-app'
          }
        })
      ])

      project.log.info({documentId}, `Document ${job.event}`)
    },
    catch (err, job) {
      if (job) {
        // try again right after the first failure
        if (job._tries === 1) setTimeout(() => queue.unshift(job), 3000)

        // try again, but after the queue is empty and after 5 seconds
        else if (job._tries === 2) setTimeout(() => queue.push(job), 5000)

        const ctx = {
          job: {...job, _project: undefined},
          err: {
            message: err.message,
            stack: err.stack,
            status: err.response && err.response.status,
            data: err.response && err.response.data
          }
        }

        if (job._tries < 3) {
          job._project.log.info(ctx, `Job failed ${job._tries} times. Retrying.`)
        } else {
          job._project.log.info(ctx, `Job failed after ${job._tries} retries. Cancelling.`)
        }
        return
      } else {
        console.error({err}, 'Job Queue Error')
      }
    }
  })

  const projects = initProjects()
  if (!projects.length) logger.warn('No tokens Configured.')

  return Promise.all(projects.map(async (project) => {
    const store = await createStore(project)
    store.start()

    project.log.info(`Starting purger for project ${project.name} with id ${project.projectId}`)
    for await (const message of store.follow()) {
      message._tries = 0
      message._project = project
      queue.push(message)
      if (queue.length === 200) await queue.drain()
    }
  }))
}

const prexit = require('prexit')
prexit.signals.push('unhandledRejection')
prexit.logExceptions = false

prexit((signal, error) => {
  if ([0, 'SIGTERM', 'SIGINT'].includes(signal)) {
    logger.warn(`Shutting down after running for ${process.uptime()}s`)
  } else {
    const err = signal instanceof Error ? signal : error
    logger.fatal({err}, `Processing error. Shutting down after running for ${process.uptime()}s`)
  }
})

logger.warn('Starting process.')
start()
