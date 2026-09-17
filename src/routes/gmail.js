import { Router } from 'express'
import HubMember from '../models/HubMember.js'
import EmailTemplate from '../models/EmailTemplate.js'
import LeAgency from '../models/LeAgency.js'
import { resolveActor } from '../middleware/auth.js'
import { requireFullAccess, resolveActorEmail } from '../middleware/featureAccess.js'
import {
  PLACEHOLDERS,
  TEMPLATE_KEYS,
  completeConnect,
  connectUrl,
  disconnect,
  getMessage,
  getTemplate,
  listInbox,
  readState,
  recentPeople,
  renderTemplate,
  sendAsMember,
  statusFor,
} from '../services/gmail.js'

/**
 * The consent callback. Google sends the browser here with no Auth0 session,
 * so this router is mounted above requireAuth and trusts only the signed
 * state it issued. Nothing else about Gmail lives up here.
 */
export const gmailCallbackRouter = Router()

gmailCallbackRouter.get('/', async (req, res) => {
  const frontend = (process.env.HUB_FRONTEND_URL?.trim() || 'https://trusted-fe-hub-agl8a.ondigitalocean.app').replace(/\/$/, '')
  const back = (outcome, detail = '') =>
    res.redirect(`${frontend}/gmail?gmail=${outcome}${detail ? `&reason=${encodeURIComponent(detail)}` : ''}`)
  try {
    if (req.query.error) return back('denied', String(req.query.error))
    const { email } = readState(req.query.state)
    const address = await completeConnect(email, String(req.query.code || ''))
    return back('connected', address)
  } catch (error) {
    return back('failed', String(error?.message || error).slice(0, 200))
  }
})

/** Everything a signed-in person does with their own Gmail. */
const router = Router()

const looksLikeEmail = (value) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)

const memberFor = async (req) => {
  const email = await resolveActorEmail(req)
  if (!email) throw Object.assign(new Error('Your account has no email, so Gmail cannot be connected to it.'), { statusCode: 403 })
  return { email, member: await HubMember.findOne({ email }).lean() }
}

router.get('/status', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    res.json(statusFor(member))
  } catch (error) {
    next(error)
  }
})

/** Where to send the browser to grant access. The page opens it in a new tab. */
router.get('/connect', async (req, res, next) => {
  try {
    const { email } = await memberFor(req)
    res.json({ url: connectUrl(email) })
  } catch (error) {
    next(error)
  }
})

router.delete('/', async (req, res, next) => {
  try {
    const { email } = await memberFor(req)
    await disconnect(email)
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

/** A page of their inbox. `q` is Gmail's own search syntax. */
/**
 * Suggestions for a To field: hub members first, then people this mailbox
 * has written to or heard from, then agency contacts on file. Matched on
 * name or address, eight at most.
 */
router.get('/contacts', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    const q = String(req.query.q || '').trim().toLowerCase()
    if (q.length < 2) return res.json([])
    const hit = (p) => `${p.name} ${p.email}`.toLowerCase().includes(q)

    const members = (await HubMember.find({}).select('name email').lean()).map((m) => ({
      name: m.name || '',
      email: m.email,
      source: 'Team',
    }))
    const people = member?.gmail?.refreshToken
      ? (await recentPeople(member)).map((p) => ({ ...p, source: 'Recent' }))
      : []
    const agencies = (
      await LeAgency.find({ 'contacts.email': { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } })
        .select('agencyName contacts.email contacts.chiefName')
        .limit(5)
        .lean()
    ).map((a) => ({
      name: a.contacts?.chiefName ? `${a.contacts.chiefName} (${a.agencyName})` : a.agencyName,
      email: String(a.contacts.email).toLowerCase(),
      source: 'Agency',
    }))

    const out = []
    const used = new Set()
    for (const p of [...members.filter(hit), ...people.filter(hit), ...agencies]) {
      if (used.has(p.email)) continue
      used.add(p.email)
      out.push(p)
      if (out.length >= 8) break
    }
    res.json(out)
  } catch (error) {
    next(error)
  }
})

router.get('/inbox', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    res.json(
      await listInbox(member, {
        q: String(req.query.q || '').slice(0, 200),
        pageToken: String(req.query.pageToken || ''),
        folder: String(req.query.folder || 'inbox'),
      }),
    )
  } catch (error) {
    next(error)
  }
})

router.get('/messages/:id', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    res.json(await getMessage(member, String(req.params.id)))
  } catch (error) {
    next(error)
  }
})

/** Reply to a message in their inbox, threaded under it. */
router.post('/messages/:id/reply', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    const text = String(req.body?.body || '').trim().slice(0, 10000)
    if (!text) return res.status(400).json({ message: 'Write something first.' })
    const original = await getMessage(member, String(req.params.id))
    // Reply to the sender, at the reply-to address if one was given.
    const to = original.from
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`
    const id = await sendAsMember(member, {
      to,
      subject,
      text,
      fromName: member?.name || '',
      thread: {
        threadId: original.threadId,
        messageId: original.messageId,
        references: [original.references, original.messageId].filter(Boolean).join(' '),
      },
    })
    return res.json({ ok: true, id })
  } catch (error) {
    return next(error)
  }
})

/** The template as written, plus the placeholders it may use. Anyone can read it. */
router.get('/template/:key', async (req, res, next) => {
  try {
    const key = String(req.params.key)
    if (!TEMPLATE_KEYS.includes(key)) return res.status(404).json({ message: 'No such template.' })
    return res.json({ ...(await getTemplate(key)), placeholders: PLACEHOLDERS })
  } catch (error) {
    return next(error)
  }
})

router.put('/template/:key', requireFullAccess, async (req, res, next) => {
  try {
    const key = String(req.params.key)
    if (!TEMPLATE_KEYS.includes(key)) return res.status(404).json({ message: 'No such template.' })
    const doc = await EmailTemplate.findOneAndUpdate(
      { key },
      {
        $set: {
          subject: String(req.body?.subject || '').slice(0, 300),
          body: String(req.body?.body || '').slice(0, 10000),
          updatedBy: await resolveActor(req),
        },
        $setOnInsert: { key },
      },
      { upsert: true, new: true },
    ).lean()
    return res.json({ ...doc, placeholders: PLACEHOLDERS })
  } catch (error) {
    return next(error)
  }
})

/** The template filled in for one agency, as this person would send it. */
router.get('/template/:key/preview/:ori', async (req, res, next) => {
  try {
    const key = String(req.params.key)
    if (!TEMPLATE_KEYS.includes(key)) return res.status(404).json({ message: 'No such template.' })
    const { member, email } = await memberFor(req)
    const agency = await LeAgency.findOne({ ori: String(req.params.ori).toUpperCase() })
      .select('ori agencyName state county city location.city contacts')
      .lean()
    if (!agency) return res.status(404).json({ message: 'Agency was not found.' })
    const rendered = renderTemplate(await getTemplate(key), agency, member || { email })
    return res.json({ ...rendered, to: agency.contacts?.email || '', ...statusFor(member) })
  } catch (error) {
    return next(error)
  }
})

/** A plain email to anyone, from the Gmail page. Not tied to an agency, so not logged on one. */
router.post('/compose', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    const to = String(req.body?.to || '').trim().toLowerCase()
    const subject = String(req.body?.subject || '').trim().slice(0, 300)
    const body = String(req.body?.body || '').trim().slice(0, 10000)
    if (!to || !subject || !body) return res.status(400).json({ message: 'To, subject and body are all needed.' })
    if (!looksLikeEmail(to)) return res.status(400).json({ message: `"${to}" does not look like an email address.` })
    const id = await sendAsMember(member, { to, subject, text: body, fromName: member?.name || '' })
    return res.json({ ok: true, id, to })
  } catch (error) {
    return next(error)
  }
})

/**
 * Send one email from an agency's pin as the signed-in person, and log it on
 * the agency next to the calls. Subject and body arrive as composed, so what
 * they read is what goes out. The address defaults to the agency's own and
 * can be changed - a chief's direct address from a voicemail greeting, say.
 */
router.post('/send', async (req, res, next) => {
  try {
    const { member, email } = await memberFor(req)
    const ori = String(req.body?.ori || '').toUpperCase()
    const subject = String(req.body?.subject || '').trim().slice(0, 300)
    const body = String(req.body?.body || '').trim().slice(0, 10000)
    if (!ori || !subject || !body) return res.status(400).json({ message: 'An agency, a subject and a body are needed.' })

    const agency = await LeAgency.findOne({ ori }).select('ori agencyName contacts').lean()
    if (!agency) return res.status(404).json({ message: 'Agency was not found.' })
    const to = String(req.body?.to || agency.contacts?.email || '').trim().toLowerCase()
    if (!to) return res.status(400).json({ message: 'Who is it going to?' })
    if (!looksLikeEmail(to)) return res.status(400).json({ message: `"${to}" does not look like an email address.` })

    const id = await sendAsMember(member, { to, subject, text: body, fromName: member?.name || '' })

    // On the call log, because that is the one timeline someone reads before
    // picking the agency up. An email after a voicemail is part of the call.
    const now = new Date()
    await LeAgency.updateOne(
      { ori },
      {
        $push: {
          callLog: {
            calledAt: now,
            contactName: agency.contacts?.chiefName || '',
            contactTitle: agency.contacts?.chiefTitle || '',
            phone: '',
            outcome: 'Follow-up email sent',
            notes: `To ${to}\nSubject: ${subject}\n\n${body}`,
            clientCallId: `gmail:${id}`,
            loggedBy: email,
            loggedAt: now,
          },
        },
        $set: { 'outreach.lastCalledAt': now, 'outreach.lastOutcome': 'Follow-up email sent', 'outreach.lastLoggedBy': email },
        $inc: { 'outreach.callCount': 1 },
      },
    )
    return res.json({ ok: true, id, to })
  } catch (error) {
    return next(error)
  }
})

export default router
