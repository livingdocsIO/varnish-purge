const path = require('path')
const delay = require('util').promisify(setTimeout)
const protobuf = require('protobufjs')

module.exports = async function createStore (opts) {
  const {log, eventPollInterval} = opts
  const publicationEvent = await PublicationEvent()
  const storagePath = path.resolve(opts.storagePath || './', `project-${opts.projectId}.db`)
  const store = require('flumelog-aligned-offset')(storagePath, {codec: publicationEvent})

  const axios = require('axios').create({
    baseURL: opts.apiBaseUrl,
    headers: {
      'User-Agent': 'livingdocs-ban',
      Authorization: `Bearer ${opts.token}`
    }
  })

  async function getHead () {
    if (!store.length) return

    return new Promise((resolve, reject) => {
      store
        .stream({seqs: false, reverse: true})
        .pipe({
          head: undefined,
          paused: false,
          write (v) {
            this.head = v
            this.paused = true
            this.end()
          },
          end (err) {
            this.ended = err || true
            if (err) return reject(err)
            resolve(this.head)
          }
        })
    })
  }

  function follow ({since} = {}) {
    const sinceTimestamp = (since && since.getTime) ? since.getTime() : (since || Date.now())
    return {
      [Symbol.asyncIterator]() {
        // The event loop doesn't stay open without that
        const interval = setInterval(() => {}, 10000)
        const messages = []
        let promise
        let err
        store.stream({seqs: false, live: true})
          .pipe({
            write (value) {
              if (value.ts < sinceTimestamp) return
              if (promise) {
                promise.resolve({done: false, value})
                promise = undefined
              } else {
                messages.push(value)
              }
            },
            end (_err) {
              clearInterval(interval)
              if (promise) {
                promise.reject(err)
                promise = undefined
              } else {
                err = _err
              }
            }
          })

        return {
          async next() {
            if (err) throw err
            const value = messages.shift()
            if (value) return {done: false, value}
            return new Promise((resolve, reject) => { promise = {resolve, reject} })
          }
        }
      }
    }
  }

  let readyPromise
  function onReady () {
    if (readyPromise) return readyPromise
    readyPromise = new Promise((resolve, reject) => {
      store.onReady((err) => err ? reject(err) : resolve())
    })
    return readyPromise
  }

  function appendMessages (messages) {
    return new Promise((resolve, reject) => {
      store.append(messages, (err, res) => err ? reject(err) : resolve(res))
    })
  }

  async function start () {
    await onReady()
    let after = (await getHead() || {}).id || 0
    while (true) {
      try {
        const res = await axios({
          method: 'GET',
          url: `/api/v1/publicationEvents?after=${after}&limit=1000`
        })

        if (Array.isArray(res.data) &&  res.data.length) {
          await appendMessages(res.data)
          const last = res.data[res.data.length - 1].id
          log.info(`Retrieved ${res.data.length} updates. Fetched up to id ${last}`)
          after = last
          continue
        }
      } catch (err) {
        log.error({
          err: {message: err.message, stack: err.stack},
          data: err.response && err.response.data
        }, 'Feed fetch error.')
      }

      await delay(eventPollInterval)
    }
  }

  return {
    start,
    get ready  () { return onReady() },
    get head () { return getHead() },
    follow
  }
}

async function PublicationEvent () {
  const {EVENT, DOCUMENTTYPE, PublicationEvent} = await protobuf.load('message.proto')

  return {
    encode (message) {
      return PublicationEvent.encode({
        id: message.id,
        ts: Date.parse(message.createdAt),
        event: EVENT[message.eventType],
        documentId: message.documentId,
        documentType: DOCUMENTTYPE[message.documentType],
        contentType: message.contentType
      }).finish()
    },
    decode (buffer) {
      const message = PublicationEvent.decode(buffer)
      message.event = EVENT[message.event]
      message.documentType = DOCUMENTTYPE[message.documentType]
      return message
    }
  }
}
