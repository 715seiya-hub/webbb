import { NextResponse } from 'next/server'

export async function GET() {
  const key = process.env.GEMINI_API_KEY ?? ''
  const hasKey = key.length > 0
  const keyPrefix = hasKey ? key.slice(0, 6) + '...' : 'NOT SET'

  // Test Gemini API with a simple text request
  let apiStatus = 'unknown'
  let apiDetail = ''
  let availableModels: string[] = []

  if (hasKey) {
    try {
      // List models to check API key validity
      const modelsRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
      )
      if (modelsRes.ok) {
        const data = await modelsRes.json()
        availableModels = (data.models ?? [])
          .map((m: { name: string }) => m.name)
          .filter((n: string) => n.includes('flash'))
        apiStatus = 'ok'
      } else {
        apiStatus = `error ${modelsRes.status}`
        apiDetail = await modelsRes.text().catch(() => '')
      }
    } catch (err) {
      apiStatus = 'fetch_failed'
      apiDetail = err instanceof Error ? err.message : String(err)
    }
  }

  return NextResponse.json({
    hasKey,
    keyPrefix,
    apiStatus,
    apiDetail: apiDetail.slice(0, 300),
    flashModels: availableModels,
  })
}
