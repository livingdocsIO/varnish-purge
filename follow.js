const delay = require('util').promisify(setTimeout)

module.exports = function follow ({
  log, database, since, live = false, projectId, documentType, contentType
}) {
  function placeholder (arr) {
    return `(${', ?'.repeat(arr.length).replace(', ', '')})`
  }

  return {
    [Symbol.asyncIterator]() {
      const sinceTimestamp = (since === undefined || since === null) ?
        Date.now() : (since.getTime ? since.getTime() : (since || 0))

      const filter = {text: '', values: []}
      if (projectId) {
        if (!Array.isArray(projectId)) projectId = `${projectId}`.split(/[ ,;]+/)
        if (projectId.length) {
          filter.text += `AND t.project_id IN ${placeholder(projectId)} `
          filter.values.push(...projectId)
        }
      }

      if (documentType) {
        if (!Array.isArray(documentType)) documentType = `${documentType}`.split(/[ ,;]+/)
        if (documentType.length) {
          filter.text += `AND t.document_type_handle IN ${placeholder(documentType)} `
          filter.values.push(...documentType)
        }
      }

      if (contentType) {
        if (!Array.isArray(contentType)) contentType = `${contentType}`.split(/[ ,;]+/)
        if (contentType.length) {
          filter.text += `AND t.content_type_handle IN ${placeholder(contentType)} `
          filter.values.push(...contentType)
        }
      }

      let after = 0
      return {
        async next() {
          while (true) {
            try {
              const value = await database.read.all(`
                SELECT
                  e.idx AS id,
                  e.ts AS ts,
                  CASE e.event_type
                    WHEN 1 THEN 'publish'
                    WHEN 2 THEN 'update'
                    WHEN 3 THEN 'unpublish'
                    ELSE NULL
                  END as event,
                  e.document_id as "documentId",
                  t.document_type_handle AS "documentType",
                  t.content_type_handle AS "contentType"
                FROM document_publication_events e
                JOIN document_content_types t ON (e.content_type_id = t.id)
                WHERE e.idx > ? AND e.ts > ?
                ${filter.text}
                ORDER BY e.idx ASC
                LIMIT 10
              `, after, sinceTimestamp, ...filter.values)
              if (value.length) {
                after = value[value.length - 1].id
                return {done: false, value}
              } else if (live !== true) {
                return {done: true}
              }
            } catch (err) {
              log.error({err}, 'Failed to fetch from events table')
            }
            await delay(1000)
          }
        }
      }
    }
  }
}
