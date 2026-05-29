import { NextRequest, NextResponse } from 'next/server'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''

const PROMPT_STANDARD = `この画像にクイズの問題が映っています。問題を読み取り、正解を簡潔に答えてください。
問題が見つからない場合は「？」とだけ答えてください。
回答のみを返してください。説明は不要です。`

const PROMPT_DEEP = `この画像にクイズの問題が映っています。問題を注意深く読み取り、正解を答えてください。
複数の選択肢がある場合は正しい選択肢を選んでください。
問題が見つからない場合は「？」とだけ答えてください。
回答と、必要であれば簡単な根拠を返してください。`

// Simple server-side rate limiter: max 10 requests per 60 seconds
let requestTimestamps: number[] = []
const MAX_REQUESTS = 6
const WINDOW_MS = 60_000

function checkRateLimit(): boolean {
  const now = Date.now()
  requestTimestamps = requestTimestamps.filter((t) => now - t < WINDOW_MS)
  if (requestTimestamps.length >= MAX_REQUESTS) return false
  requestTimestamps.push(now)
  return true
}

export async function POST(request: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json(
      { error: 'GEMINI_API_KEY not configured' },
      { status: 500 }
    )
  }

  if (!checkRateLimit()) {
    const oldest = requestTimestamps[0]
    const waitSec = Math.ceil((WINDOW_MS - (Date.now() - oldest)) / 1000)
    return NextResponse.json(
      { error: `サーバー側レート制限: ${waitSec}秒後に再試行`, status: 429, waitSec },
      { status: 429 }
    )
  }

  try {
    const formData = await request.formData()
    const imageFile = formData.get('image') as File | null
    const deep = formData.get('deep') === '1'

    if (!imageFile) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 })
    }

    const bytes = await imageFile.arrayBuffer()
    const base64 = Buffer.from(bytes).toString('base64')
    const mimeType = imageFile.type || 'image/jpeg'
    const prompt = deep ? PROMPT_DEEP : PROMPT_STANDARD
    const maxTokens = deep ? 1024 : 256

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inlineData: { mimeType, data: base64 } },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0.1,
          },
        }),
      }
    )

    if (!geminiResponse.ok) {
      const errorBody = await geminiResponse.text().catch(() => '')

      if (geminiResponse.status === 429) {
        // Remove last timestamp so we don't count failed requests
        requestTimestamps.pop()
        return NextResponse.json(
          { error: 'Gemini APIレート制限。間隔を広げてください', status: 429 },
          { status: 429 }
        )
      }

      return NextResponse.json(
        { error: `Gemini API error: ${geminiResponse.status}`, status: geminiResponse.status, detail: errorBody.slice(0, 200) },
        { status: geminiResponse.status }
      )
    }

    const data = await geminiResponse.json()
    const candidate = data.candidates?.[0]
    const text = candidate?.content?.parts?.[0]?.text ?? '？'
    const finishReason = candidate?.finishReason ?? 'unknown'
    const blockReason = data.promptFeedback?.blockReason

    return NextResponse.json({
      text,
      source: 'gemini-2.0-flash',
      finishReason,
      blockReason: blockReason ?? null,
      bytes: bytes.byteLength,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
