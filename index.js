const jwt = require('jsonwebtoken')
const createStore = require('./store')
const logger = require('pino')({base: null})
const pkg = require('./package.json')

const storagePath = process.env.STORAGE_PATH

// The livigndocs api, e.g. https://bluewin-server.livingdocs.io
const apiUrl = process.env.API_URL

// How often should we poll the event stream
const eventPollInterval = Math.max(3000, process.env.API_POLL_INTERVAL || 5000)

// Host Header used for requests, e.g. bluewin.livingdocs.io
const frontendHostHeader = new URL(process.env.FRONTEND_URL).host

// Varnish URL, e.g. http://varnish/
const varnishUrl = process.env.VARNISH_URL

// Whether we should trigger purge calls against all DNS A records behind the hostname
const useMultiHostPurge = process.env.VARNISH_MULTIPURGE === 'true'

const axios = useMultiHostPurge ? require('./request') : require('axios')

// Declare the livingdocs tokens as environment variables
// TOKEN_de
// TOKEN_fr
// TOKEN_it

function getProjects () {
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

async function start ({since, live}) {
  logger.warn('Starting process.')
  require('./exit-handlers')({
    logger,
    onStop () {
      return Promise.all([
        queue && queue.stop(),
        ...(stores || []).map((s) => s.stop()),
        database && database.close()
      ])
    }
  })

  const queue = require('./process')({log: logger, concurrency: 20, frontendHostHeader})
  const projects = getProjects()
  if (!projects.length) {
    logger.warn('No tokens Configured.')
    return
  }

  const database = await require('./database')(storagePath)
  const follow = require('./follow')

  if (live === true) {
    const stores = await Promise.all(projects.map(initializeProject))
    for (const store of stores) store.start()
  }

  async function initializeProject (project) {
    let stopped = false
    const store = await createStore(project, database)

    async function start () {
      project.log.info(`Starting purger for project ${project.name} with id ${project.projectId}`)
      store.start()

      const followOpts = {log: project.log, database, projectId: project.projectId, live, since}
      for await (const messages of follow(followOpts)) {
        if (stopped) break
        for (const message of messages) {
          message._tries = 0
          message._project = project
          if (live === false && message.event === 'unpublish') continue
          queue.push(message)
        }
        await queue.drain(1000)
      }
      project.warn.info('Follower stopped')
    }

    function stop () {
      stopped = true
      store.stop()
    }

    return {start, stop}
  }
}

start({live: true})
