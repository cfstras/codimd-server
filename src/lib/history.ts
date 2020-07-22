// history
// external modules
import LZString from 'lz-string'
import { Op } from 'sequelize'

// core
import { logger } from './logger'
import { Note, User } from './models'
import { errors } from './errors'
import { LogEntry } from 'winston'

// public

class HistoryObject {
  id: string
  text: string
  time: number
  tags: string[]
  pinned?: boolean
}

function parseHistoryMapToArray (historyMap: Map<string, HistoryObject>): HistoryObject[] {
  const historyArray: HistoryObject[] = []
  for (const [, value] of historyMap) {
    historyArray.push(value)
  }
  return historyArray
}

function parseHistoryArrayToMap (historyArray: HistoryObject[]): Map<string, HistoryObject> {
  const historyMap = new Map()
  for (let i = 0; i < historyArray.length; i++) {
    const item = historyArray[i]
    historyMap.set(item.id, item)
  }
  return historyMap
}

function getHistory (userId, callback: (err: unknown, history: Map<string, HistoryObject> | null) => void): void {
  User.findOne({
    where: {
      id: userId
    }
  }).then(function (user) {
    if (!user) {
      return callback(null, null)
    }
    if (user.history) {
      const history: HistoryObject[] = JSON.parse(user.history)
      // migrate LZString encoded note id to base64url encoded note id
      for (let i = 0, l = history.length; i < l; i++) {
        // Calculate minimal string length for an UUID that is encoded
        // base64 encoded and optimize comparsion by using -1
        // this should make a lot of LZ-String parsing errors obsolete
        // as we can assume that a nodeId that is 48 chars or longer is a
        // noteID.
        const base64UuidLength = ((4 * 36) / 3) - 1
        if (!(history[i].id.length > base64UuidLength)) {
          continue
        }
        try {
          const id = LZString.decompressFromBase64(history[i].id)
          if (id && Note.checkNoteIdValid(id)) {
            history[i].id = Note.encodeNoteId(id)
          }
        } catch (err) {
          // most error here comes from LZString, ignore
          if (err.message === 'Cannot read property \'charAt\' of undefined') {
            logger.warning('Looks like we can not decode "' + history[i].id + '" with LZString. Can be ignored.')
          } else {
            logger.error(err)
          }
        }
      }
      logger.debug(`read history success: ${user.id}`)
      return callback(null, parseHistoryArrayToMap(history))
    }
    logger.debug(`read empty history: ${user.id}`)
    return callback(null, new Map<string, HistoryObject>())
  }).catch(function (err) {
    logger.error('read history failed: ' + err)
    return callback(err, null)
  })
}

function setHistory (userId: string, history: HistoryObject[], callback: (err: LogEntry | null, count: [number, User[]] | null) => void): void {
  User.update({
    history: JSON.stringify(history)
  }, {
    where: {
      id: userId
    }
  }).then(function (count) {
    return callback(null, count)
  }).catch(function (err) {
    logger.error('set history failed: ' + err)
    return callback(err, null)
  })
}

function updateHistory (userId: string, noteId: string, document, time): void {
  if (userId && noteId && typeof document !== 'undefined') {
    getHistory(userId, function (err, history) {
      if (err || !history) return
      const noteHistory = history.get(noteId) || new HistoryObject()
      const noteInfo = Note.parseNoteInfo(document)
      noteHistory.id = noteId
      noteHistory.text = noteInfo.title
      noteHistory.time = time || Date.now()
      noteHistory.tags = noteInfo.tags
      history.set(noteId, noteHistory)
      setHistory(userId, parseHistoryMapToArray(history), function (err, _) {
        if (err) {
          logger.log(err)
        }
      })
    })
  }
}

function historyGet (req, res): void {
  if (req.isAuthenticated()) {
    getHistory(req.user.id, function (err, history) {
      if (err) return errors.errorInternalError(res)
      if (!history) return errors.errorNotFound(res)
      res.send({
        history: parseHistoryMapToArray(history)
      })
    })
  } else {
    return errors.errorForbidden(res)
  }
}

function historyPost (req, res): void {
  if (req.isAuthenticated()) {
    const noteId = req.params.noteId
    if (!noteId) {
      if (typeof req.body.history === 'undefined') return errors.errorBadRequest(res)
      logger.debug(`SERVER received history from [${req.user.id}]: ${req.body.history}`)
      let history
      try {
        history = JSON.parse(req.body.history)
      } catch (err) {
        return errors.errorBadRequest(res)
      }
      if (Array.isArray(history)) {
        setHistory(req.user.id, history, function (err, _) {
          if (err) return errors.errorInternalError(res)
          res.end()
        })
      } else {
        return errors.errorBadRequest(res)
      }
    } else {
      if (typeof req.body.pinned === 'undefined') return errors.errorBadRequest(res)
      getHistory(req.user.id, function (err, history) {
        if (err) return errors.errorInternalError(res)
        if (!history) return errors.errorNotFound(res)
        const noteHistory = history.get(noteId)
        if (!noteHistory) return errors.errorNotFound(res)
        if (req.body.pinned === 'true' || req.body.pinned === 'false') {
          noteHistory.pinned = (req.body.pinned === 'true')
          setHistory(req.user.id, parseHistoryMapToArray(history), function (err, _) {
            if (err) return errors.errorInternalError(res)
            res.end()
          })
        } else {
          return errors.errorBadRequest(res)
        }
      })
    }
  } else {
    return errors.errorForbidden(res)
  }
}

function historyDelete (req, res): void {
  if (req.isAuthenticated()) {
    const noteId = req.params.noteId
    if (!noteId) {
      setHistory(req.user.id, [], function (err, _) {
        if (err) return errors.errorInternalError(res)
        res.end()
      })
    } else {
      getHistory(req.user.id, function (err, history) {
        if (err) return errors.errorInternalError(res)
        if (!history) return errors.errorNotFound(res)
        history.delete(noteId)
        setHistory(req.user.id, parseHistoryMapToArray(history), function (err, _) {
          if (err) return errors.errorInternalError(res)
          res.end()
        })
      })
    }
  } else {
    return errors.errorForbidden(res)
  }
}

function index (req, res) {
  // TODO check whether setting is on
  if (!req.isAuthenticated()) {
    return errors.errorForbidden(res)
  }
  Note.findAll({
    attributes: [
      'alias', 'createdAt', 'id', 'lastchangeAt', 'permission', 'shortId',
      'title', 'viewcount'
    ],
    where: {
      content: {
        [Op.ne]: ''
      },
      [Op.or]: [
        {
          permission: { [Op.ne]: 'private' }
        },
        {
          ownerId: req.user.id
        }
      ]
    }
  }).then(function (notes) {
    if (!notes) {
      return errors.errorNotFound(res)
    }
    logger.debug(`read index success: ${req.user.id}`)
    res.send({ index: notes })
  }).catch(function (err) {
    logger.error('read index failed: ' + err)
    return errors.errorInternalError(res)
  })
}

const History = {
  historyGet: historyGet,
  historyPost: historyPost,
  historyDelete: historyDelete,
  updateHistory: updateHistory,
  notesIndex: index
}

export { History, HistoryObject }
