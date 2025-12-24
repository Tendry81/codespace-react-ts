const express = require('express')
const cors = require('cors')
const app = express()
const port = 3001

app.use(cors({
    origin: (origin, cb) => {
      if (
        !origin ||
        origin.includes(".app.github.dev") ||
        origin.includes("localhost")
      ) {
        cb(null, origin);
      } else {
        cb(new Error("CORS blocked"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  }))

app.get('/health', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Agent listening on port ${port}`)
})
