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

async function start (opts) {
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

  const stores = await Promise.all(projects.map(initializeProject))
  for (const store of stores) store.start()

  async function initializeProject (project) {
    let stopped = false
    const store = await createStore(project, database)

    async function start () {
      project.log.info(`Starting purger for project ${project.name} with id ${project.projectId}`)
      // do not start the event sync during cli execution
      if (opts.live) store.start()

      const followOpts = {...opts, log: project.log, database, projectId: project.projectId}
      for await (const messages of follow(followOpts)) {
        if (stopped) break
        loopmessages: for (const message of messages) {
          message._tries = 0
          message._project = project
          // Do not trigger a ban of deleted documents when we're using the cli
          if (opts.live === false && message.event === 'unpublish') continue loopmessages
          queue.push(message)
        }
        // Don't push too many messages into the queue, we'll have a maximum of 200 entries
        await queue.drain(200)
      }
      // Wait for everything to finish and then stop the process
      await queue.drain(0)
      project.log.info('Follower stopped')
    }

    function stop () {
      stopped = true
      store.stop()
    }

    return {start, stop}
  }
}

// Either run the process using `node index.js` to start the regular process
// or run
//    node index.js --precache --duration=1w --documentType=page
//    node index.js --precache --duration=1d --contentType=page,regular

const args = require('yargs-parser')(process.argv.slice(2))
if (args.precache) {
  const time = require('ms')(args.duration || '1d')
  start({...args, live: false, since: Date.now() - time})
} else {
  start({live: true})
}
