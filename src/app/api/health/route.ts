import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const key = process.env.GEMINI_API_KEY ?? ''
  const hasKey = key.length > 0

  if (!hasKey) {
    return NextResponse.json({
      status: 'NG',
      reason: 'GEMINI_API_KEY が環境変数に設定されていません',
    })
  }

  // テストリクエスト: 簡単なテキストプロンプトで動作確認
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: '1+1=?' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
      }
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return NextResponse.json({
        status: 'NG',
        reason: `Gemini API error ${res.status}`,
        detail: body.slice(0, 500),
        keyPrefix: key.slice(0, 8) + '...',
      })
    }

    const data = await res.json()
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'no answer'

    return NextResponse.json({
      status: 'OK',
      testAnswer: answer.trim(),
      model: 'gemini-2.0-flash',
      keyPrefix: key.slice(0, 8) + '...',
    })
  } catch (err) {
    return NextResponse.json({
      status: 'NG',
      reason: 'ネットワークエラー',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}
