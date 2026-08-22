import { Router } from 'express'
import {
  listContactLists,
  listSenders,
  createCampaign,
  sendTestEmail,
  sendCampaignNow,
  sendTransactionalEmail,
} from '../services/brevoApi.js'
import { hostInlineImages, publicBaseUrl } from '../services/emailAssets.js'

const router = Router()

router.get('/lists', async (_req, res, next) => {
  try {
    res.json(await listContactLists())
  } catch (error) {
    next(error)
  }
})

router.get('/senders', async (_req, res, next) => {
  try {
    res.json(await listSenders())
  } catch (error) {
    next(error)
  }
})

// Creates the campaign as a Brevo draft. Deliberately does NOT send — sending
// is a separate, explicit call so a mis-click here can never reach a real list.
router.post('/campaigns', async (req, res, next) => {
  try {
    const { name, subject, senderName, senderEmail, htmlContent, listIds } = req.body || {}

    if (!subject?.trim()) return res.status(400).json({ message: 'Subject is required' })
    if (!senderEmail?.trim()) return res.status(400).json({ message: 'A sender is required' })
    if (!htmlContent?.trim()) return res.status(400).json({ message: 'Email content is empty' })
    if (!Array.isArray(listIds) || listIds.length === 0) {
      return res.status(400).json({ message: 'Select at least one recipient list' })
    }

    const hosted = await hostInlineImages(htmlContent, publicBaseUrl(req))

    const campaign = await createCampaign({
      name: name?.trim() || subject.trim(),
      subject: subject.trim(),
      senderName: senderName?.trim() || senderEmail.trim(),
      senderEmail: senderEmail.trim(),
      htmlContent: hosted,
      listIds: listIds.map(Number),
    })

    res.status(201).json({ id: campaign?.id })
  } catch (error) {
    next(error)
  }
})

router.post('/send-direct', async (req, res, next) => {
  try {
    const { subject, senderName, senderEmail, htmlContent, to } = req.body || {}

    if (!subject?.trim()) return res.status(400).json({ message: 'Subject is required' })
    if (!senderEmail?.trim()) return res.status(400).json({ message: 'A sender is required' })
    if (!htmlContent?.trim()) return res.status(400).json({ message: 'Email content is empty' })
    if (!Array.isArray(to) || to.length === 0) {
      return res.status(400).json({ message: 'Provide at least one recipient address' })
    }

    await sendTransactionalEmail({
      subject: subject.trim(),
      senderName: senderName?.trim() || senderEmail.trim(),
      senderEmail: senderEmail.trim(),
      htmlContent: await hostInlineImages(htmlContent, publicBaseUrl(req)),
      to,
    })

    res.json({ sent: true })
  } catch (error) {
    next(error)
  }
})

router.post('/campaigns/:id/test', async (req, res, next) => {
  try {
    const emails = req.body?.emails
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ message: 'Provide at least one test recipient' })
    }
    await sendTestEmail(req.params.id, emails)
    res.json({ sent: true })
  } catch (error) {
    next(error)
  }
})

router.post('/campaigns/:id/send', async (req, res, next) => {
  try {
    await sendCampaignNow(req.params.id)
    res.json({ sent: true })
  } catch (error) {
    next(error)
  }
})

export default router
