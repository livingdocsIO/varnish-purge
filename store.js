const delay = require('util').promisify(setTimeout)
const Axios = require('axios')

module.exports = async function createStore (opts, database) {
  const {log, eventPollInterval} = opts

  const axios = Axios.create({
    timeout: 20000,
    baseURL: opts.apiBaseUrl,
    headers: {
      'User-Agent': 'livingdocs-ban',
      Authorization: `Bearer ${opts.token}`
    }
  })

  const contentTypeIds = new Map()
  function getContentType (m) {
    const key = `${m.projectId}:${m.channelId}:${m.documentType}:${m.contentType}`
    const contentTypeId = contentTypeIds.get(key)
    if (contentTypeId) return contentTypeId

    const promise = getContentTypeFromDb(m)
    contentTypeIds.set(key, promise)
    return promise.then((id) => {
      contentTypeIds.set(key, id)
      return id
    })
  }

  async function getContentTypeFromDb (message) {
    const res = await database.write
      .get(`
        SELECT id FROM document_content_types
        WHERE project_id = ? AND channel_id = ? AND document_type_handle = ? AND content_type_handle = ?
      `, message.projectId, message.channelId, message.documentType, message.contentType)

    if (res) return res.id

    const {lastID} = await database.write.run(`
      INSERT INTO document_content_types (project_id, channel_id, document_type_handle, content_type_handle)
      VALUES (?, ?, ?, ?)
    `, message.projectId, message.channelId, message.documentType, message.contentType)

    return lastID
  }

  const eventTypeIds = {publish: 1, update: 2, unpublish: 3}
  async function appendMessages (messages) {
    let str = ''
    let count = 0
    for (const msg of messages) {
      // A message might not have a valid structure
      if (typeof msg.id !== 'number' || typeof msg.documentId !== 'number') continue

      // A message might have an unsupported event name
      let eventTypeId = eventTypeIds[msg.eventType]
      if (!eventTypeId) continue

      let ctId = getContentType(msg)

      // If we don't have a content type id, the message was malformed
      if (!ctId) continue

      // We might need to wait until a new content type id is persisted
      if (ctId.then) ctId = await ctId

      str += `, (${msg.id}, ${eventTypeId}, ${ctId}, ${msg.documentId}, ${Date.parse(msg.createdAt) || 0})` // eslint-disable-line max-len
      count += 1
    }

    if (count === 0) return 0

    // We can't use a parameterized query as it's limited to too 1000 entries.
    await database.write.run(`
      INSERT INTO document_publication_events (idx, event_type, content_type_id, document_id, ts)
      VALUES ${str.replace(', ', '')}
    `)
    return count
  }

  const cancelToken = Axios.CancelToken.source()
  let delayTimeout
  async function start () {
    let after = await api.head
    while (!api.stopped) {
      try {
        const res = await axios({
          cancelToken: cancelToken.token,
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
        if (Axios.isCancel(err)) return
        log.error({
          err: {message: err.message, stack: err.stack},
          data: err.response && err.response.data
        }, 'Feed fetch error.')
      }

      await new Promise((resolve) => { delayTimeout = setTimeout(resolve, eventPollInterval) })
    }
  }

  function stop () {
    api.stopped = true
    clearTimeout(delayTimeout)
    cancelToken.cancel()
  }

  const api = {
    stopped: false,
    start,
    stop,
    get head () {
      return database.write.get(`
        SELECT * FROM document_publication_events e
        JOIN document_content_types t ON (e.content_type_id = t.id)
        WHERE t.project_id = ?
        ORDER BY e.idx desc
        LIMIT 1
      `, opts.projectId).then((res) => (res && res.idx) || 0)
    }
  }

  return api
}
