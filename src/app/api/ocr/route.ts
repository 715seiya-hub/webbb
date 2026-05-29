import { NextRequest, NextResponse } from 'next/server'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''

const PROMPT_STANDARD = `この画像にクイズの問題が映っています。問題を読み取り、正解を簡潔に答えてください。
問題が見つからない場合は「？」とだけ答えてください。
回答のみを返してください。説明は不要です。`

const PROMPT_DEEP = `この画像にクイズの問題が映っています。問題を注意深く読み取り、正解を答えてください。
複数の選択肢がある場合は正しい選択肢を選んでください。
問題が見つからない場合は「？」とだけ答えてください。
回答と、必要であれば簡単な根拠を返してください。`

const MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function callGemini(
  model: string,
  base64: string,
  mimeType: string,
  prompt: string,
  maxTokens: number
): Promise<Response> {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
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
}

export async function POST(request: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json(
      { error: 'GEMINI_API_KEY not configured' },
      { status: 500 }
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

    let lastError = ''
    let usedModel = ''
    let fallbackFrom: string | null = null

    for (const model of MODELS) {
      // Retry up to 2 times per model with backoff
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await sleep(2000 * attempt)

        const geminiResponse = await callGemini(
          model,
          base64,
          mimeType,
          prompt,
          maxTokens
        )

        if (geminiResponse.ok) {
          const data = await geminiResponse.json()
          const candidate = data.candidates?.[0]
          const text = candidate?.content?.parts?.[0]?.text ?? '？'
          const finishReason = candidate?.finishReason ?? 'unknown'
          const blockReason = data.promptFeedback?.blockReason

          usedModel = model
          return NextResponse.json({
            text,
            source: usedModel,
            fallbackFrom,
            finishReason,
            blockReason: blockReason ?? null,
            bytes: bytes.byteLength,
          })
        }

        if (geminiResponse.status === 429) {
          lastError = `RATE LIMIT (429) on ${model}`
          // Try next model on rate limit
          if (attempt === 0 && model === MODELS[0]) {
            fallbackFrom = model
          }
          continue
        }

        // Other error - try to get details
        const errorBody = await geminiResponse.text().catch(() => '')
        lastError = `${model}: ${geminiResponse.status} ${errorBody.slice(0, 100)}`
        break
      }
    }

    return NextResponse.json(
      { error: lastError, status: 429 },
      { status: 429 }
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
