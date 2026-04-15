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
