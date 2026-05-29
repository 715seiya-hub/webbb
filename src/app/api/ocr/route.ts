import { NextRequest, NextResponse } from 'next/server'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''

const PROMPT_STANDARD = `この画像にクイズの問題が映っています。問題を読み取り、正解を簡潔に答えてください。
問題が見つからない場合は「？」とだけ答えてください。
回答のみを返してください。説明は不要です。`

const PROMPT_DEEP = `この画像にクイズの問題が映っています。問題を注意深く読み取り、正解を答えてください。
複数の選択肢がある場合は正しい選択肢を選んでください。
問題が見つからない場合は「？」とだけ答えてください。
回答と、必要であれば簡単な根拠を返してください。`

export async function POST(request: NextRequest) {
  // 1. APIキーチェック
  if (!GEMINI_API_KEY) {
    return NextResponse.json({
      ok: false,
      error: 'GEMINI_API_KEY未設定。Renderの Environment Variables に設定してください。',
    }, { status: 500 })
  }

  try {
    // 2. リクエスト解析
    const formData = await request.formData()
    const imageFile = formData.get('image') as File | null
    const deep = formData.get('deep') === '1'

    if (!imageFile) {
      return NextResponse.json({ ok: false, error: '画像がありません' }, { status: 400 })
    }

    const bytes = await imageFile.arrayBuffer()
    const base64 = Buffer.from(bytes).toString('base64')
    const mimeType = imageFile.type || 'image/jpeg'
    const prompt = deep ? PROMPT_DEEP : PROMPT_STANDARD

    // 3. Gemini API呼び出し（1回だけ、リトライなし）
    const model = 'gemini-2.0-flash'
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64 } },
          ],
        }],
        generationConfig: {
          maxOutputTokens: deep ? 1024 : 256,
          temperature: 0.1,
        },
      }),
    })

    // 4. エラーハンドリング
    if (!geminiRes.ok) {
      const body = await geminiRes.text().catch(() => '')
      return NextResponse.json({
        ok: false,
        error: `Gemini ${geminiRes.status}`,
        detail: body.slice(0, 300),
        model,
      }, { status: geminiRes.status })
    }

    // 5. レスポンス解析
    const data = await geminiRes.json()
    const candidate = data.candidates?.[0]
    const text = candidate?.content?.parts?.[0]?.text ?? '？'

    return NextResponse.json({
      ok: true,
      text,
      source: model,
      finishReason: candidate?.finishReason ?? 'unknown',
      blockReason: data.promptFeedback?.blockReason ?? null,
    })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
