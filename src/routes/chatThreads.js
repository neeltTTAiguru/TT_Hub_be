import { Router } from 'express'
import {
  createChatThread,
  deleteChatThread,
  getChatThread,
  listChatThreads,
  updateChatThread,
} from '../controllers/chatThreadsController.js'

const router = Router()

router.get('/', listChatThreads)
router.post('/', createChatThread)
router.get('/:id', getChatThread)
router.patch('/:id', updateChatThread)
router.delete('/:id', deleteChatThread)

export default router
