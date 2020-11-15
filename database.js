const path = require('path')
const fs = require('fs-extra')
const sqlite = require('sqlite')
const sqlite3 = require('sqlite3')

module.exports = async function setupDatabase (storage) {
  if (storage !== ':memory:') {
    storage = path.resolve(storage || './', 'database.sqlite')
    await fs.mkdirp(path.dirname(storage))
  }

  const opts = {filename: storage, driver: sqlite3.Database, }
  const write = await sqlite.open(opts)
  await write.migrate()
  await write.run([
    'PRAGMA synchronous=OFF',
    'PRAGMA count_changes=OFF',
    'PRAGMA temp_store=MEMORY',
    'PRAGMA cache_size=2000',
    'PRAGMA journal_mode=WAL'
  ].join(';'))

  const read = storage === ':memory:' ?
    write :
    await sqlite.open({...opts, mode: sqlite3.OPEN_READONLY})

  await read.run([
    'PRAGMA cache_size=2000',
    'PRAGMA journal_mode=WAL'
  ].join(';'))

  function close () {
    return Promise.all([read.close(), write.close()])
  }

  return {close, write, read}
}
