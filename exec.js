async function start () {
  const db = await require('./database')('./')

  const eventTypeIds = {publish: 1, update: 2, unpublish: 3}

  let str = ''
  for (const message of messages) {
    // A message might not have a valid structure
    if (typeof message.id !== 'numebr') continue

    // A message might have an unsupported event name
    let eventTypeId = eventTypeIds[message.event]
    if (!eventTypeId) continue

    let ctId = getContentTypeId(message)

    // If we don't have a content type id, the message was malformed
    if (!ctId) continue

    // We might need to wait until a new content type id is persisted
    if (ctId.then === 'function') ctId = await ctId

    str += `(${message.id}, ${eventTypeId}, ${ctId}, ${Date.parse(message.createdAt) || 0})`
  }

  await db.write.run(`
    INSERT INTO document_publication_events (idx, event_type, content_type_id, ts)
    VALUES ${str}
  `)

  const res = await db.write.all(`
    SELECT * FROM document_publication_events e
    JOIN document_content_types t ON (e.content_type_id = t.id)
    WHERE t.project_id = ?
  `, 1)

  console.log(res)

  // const res = await db.write
  //   .get(`
  //     SELECT id FROM document_content_types
  //     WHERE project_id = ? AND channel_id = ? AND document_type_handle = ? AND content_type_handle = ?
  //   `, 1, 1, 'article', 'interview')

  // if (res) return res.id

  // const {lastID} = await db.write.run(`
  //   INSERT INTO document_content_types (project_id, channel_id, document_type_handle, content_type_handle)
  //   VALUES (?, ?, ?, ?)
  // `, 1, 1, 'article', 'interview')
  // return lastID
}

start()
