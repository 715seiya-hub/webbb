import { NextRequest, NextResponse } from 'next/server'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''

const PROMPT_STANDARD = `この画像にクイズの問題が映っています。問題を読み取り、正解を簡潔に答えてください。
問題が見つからない場合は「？」とだけ答えてください。
回答のみを返してください。説明は不要です。`

const PROMPT_DEEP = `この画像にクイズの問題が映っています。問題を注意深く読み取り、正解を答えてください。
複数の選択肢がある場合は正しい選択肢を選んでください。
問題が見つからない場合は「？」とだけ答えてください。
回答と、必要であれば簡単な根拠を返してください。`

// Try models in order - if one fails, try next
const MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
]

// Track last request time to avoid rapid fire
let lastRequestTime = 0
const MIN_GAP_MS = 8000 // minimum 8 seconds between API calls

export async function POST(request: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json(
      { error: 'GEMINI_API_KEY が未設定です。Renderの環境変数を確認してください。' },
      { status: 500 }
    )
  }

  // Enforce minimum gap
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (elapsed < MIN_GAP_MS) {
    return NextResponse.json(
      { error: `${Math.ceil((MIN_GAP_MS - elapsed) / 1000)}秒後に再試行`, status: 429 },
      { status: 429 }
    )
  }
  lastRequestTime = now

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

    // Try each model until one succeeds
    for (const model of MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`

        const geminiResponse = await fetch(url, {
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
        })

        if (geminiResponse.status === 429) {
          // Rate limited on this model, try next
          continue
        }

        if (!geminiResponse.ok) {
          const errorText = await geminiResponse.text().catch(() => '')
          // If model not found or other error, try next model
          if (MODELS.indexOf(model) < MODELS.length - 1) continue
          return NextResponse.json(
            { error: `${model} error ${geminiResponse.status}: ${errorText.slice(0, 200)}` },
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
          source: model,
          finishReason,
          blockReason: blockReason ?? null,
          bytes: bytes.byteLength,
        })
      } catch {
        // Network error on this model, try next
        if (MODELS.indexOf(model) < MODELS.length - 1) continue
        throw new Error(`All models failed`)
      }
    }

    // All models rate limited
    lastRequestTime = 0 // Reset so next request can try
    return NextResponse.json(
      { error: '全モデルがレート制限中。間隔を広げてください。', status: 429 },
      { status: 429 }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
