import { NextRequest, NextResponse } from 'next/server'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''

const PROMPT_STANDARD = `この画像にクイズの問題が映っています。問題を読み取り、正解を簡潔に答えてください。
問題が見つからない場合は「？」とだけ答えてください。
回答のみを返してください。説明は不要です。`

const PROMPT_DEEP = `この画像にクイズの問題が映っています。問題を注意深く読み取り、正解を答えてください。
複数の選択肢がある場合は正しい選択肢を選んでください。
問題が見つからない場合は「？」とだけ答えてください。
回答と、必要であれば簡単な根拠を返してください。`

// gemini-1.5-flash-8b: 無料枠4000RPM（最も緩い）
// gemini-2.0-flash: 無料枠15RPM
// gemini-1.5-flash: 無料枠15RPM
const MODELS = ['gemini-1.5-flash-8b', 'gemini-2.0-flash', 'gemini-1.5-flash']

export async function POST(request: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({
      ok: false,
      error: 'GEMINI_API_KEY未設定。Renderの Environment Variables に設定してください。',
    }, { status: 500 })
  }

  try {
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
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }],
      generationConfig: { maxOutputTokens: deep ? 512 : 128, temperature: 0.1 },
    })

    // モデルを順番に試す（429なら次へ）
    for (const model of MODELS) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
      )

      if (res.status === 429) continue // このモデルはレート制限中、次へ

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        // モデルが存在しない(404)なら次を試す
        if (res.status === 404) continue
        return NextResponse.json({ ok: false, error: `${model}: ${res.status}`, detail: errText.slice(0, 200) }, { status: res.status })
      }

      const data = await res.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '？'

      return NextResponse.json({
        ok: true,
        text,
        source: model,
        finishReason: data.candidates?.[0]?.finishReason ?? 'unknown',
        blockReason: data.promptFeedback?.blockReason ?? null,
      })
    }

    // 全モデル429
    return NextResponse.json({
      ok: false,
      error: '全モデルがレート制限中です。数分待ってから再試行してください。',
    }, { status: 429 })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
