import mongoose from 'mongoose'

/**
 * An email the hub sends on someone's behalf, as the command board wrote it.
 *
 * Keyed by what it is for ('voicemail-followup' today), one document each.
 * Placeholders are {{like_this}} and are filled at send time from the agency
 * and the sender - see renderTemplate in services/gmail.js for the list.
 */
const emailTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true },
)

const EmailTemplate = mongoose.model('EmailTemplate', emailTemplateSchema, 'emailtemplates')

export default EmailTemplate
