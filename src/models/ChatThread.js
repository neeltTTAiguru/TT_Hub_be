import mongoose from 'mongoose'

const threadMessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false },
)

const chatThreadSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    agentId: {
      type: String,
      required: true,
      trim: true,
      default: 'market-researcher',
      index: true,
    },
    // Optional sub-scope within an agent. The Competitor Analyst reuses one
    // agentId ('competitor-analyst') for every competitor section, so without a
    // per-competitor key every competitor's saved chats would share one bucket
    // and surface under the default section (Axon). Blank for agents that don't
    // subdivide their threads.
    competitor: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    messages: {
      type: [threadMessageSchema],
      default: [],
      validate: {
        validator(messages) {
          return Array.isArray(messages) && messages.length > 0
        },
        message: 'At least one thread message is required.',
      },
    },
    thread: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
)

chatThreadSchema.index({ userId: 1, updatedAt: -1 })

const ChatThread = mongoose.model('ChatThread', chatThreadSchema)

export default ChatThread
