import { Router } from 'express'
import Product from '../models/Product.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const products = await Product.find().sort({ updatedAt: -1 })
    res.json(products)
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const product = await Product.create(req.body)
    res.status(201).json(product)
  } catch (error) {
    next(error)
  }
})

export default router
