import mongoose from 'mongoose'

/**
 * One inbound email as the mail agent saw it, and what became of it.
 *
 * `messageId` (Gmail's id) is unique, so it is also the lock: two overlapping
 * Hermes runs cannot both claim the same email, and an email is answered at
 * most once. A claim that is never settled (the run died mid-email) expires
 * and the email is offered again -- see CLAIM_TTL_MS in services/mailAgent.js.
 *
 * The `__start__` row records when the agent was first switched on. Nothing
 * that arrived before it is ever offered, so turning the agent on does not
 * answer years of old mail.
 */
const mailAgentItemSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, unique: true },
    threadId: { type: String, default: '' },
    fromEmail: { type: String, default: '' },
    from: { type: String, default: '' },
    subject: { type: String, default: '' },
    // claimed -> replied | notified | skipped; notified + approvedAt -> replied.
    // `filtered` never reaches Hermes; `instruction` rows are Neel's replies.
    status: { type: String, default: 'claimed', index: true },
    reason: { type: String, default: '' },
    reply: { type: String, default: '' },
    // trial = the reply went to Neel as "would reply"; live = to the sender.
    mode: { type: String, default: '' },
    sentId: { type: String, default: '' },
    // A "Needs you" email: its thread (where Neel's reply lands), the reply the
    // agent suggested, and Neel's instruction once he answers it.
    notifyThreadId: { type: String, default: '', index: true },
    suggestedReply: { type: String, default: '' },
    instruction: { type: String, default: '' },
    approvedAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

mailAgentItemSchema.index({ threadId: 1, status: 1, decidedAt: -1 })

const MailAgentItem = mongoose.model('MailAgentItem', mailAgentItemSchema, 'mailagentitems')

export default MailAgentItem
