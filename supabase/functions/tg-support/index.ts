import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createHmac } from 'node:crypto';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const ADMIN_BOT_TOKEN = Deno.env.get('ADMIN_BOT_TOKEN')!;
const TELEGRAM_ADMIN_CHAT_ID = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function verifyInitData(initData: string): { ok: boolean; user?: any; reason?: string } {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, reason: 'no_hash' };

    params.delete('hash');

    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map((k) => `${k}=${params.get(k)}`).join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
    const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return { ok: false, reason: 'bad_hash' };

    const userRaw = params.get('user');
    if (!userRaw) return { ok: false, reason: 'no_user' };

    const user = JSON.parse(userRaw);
    return { ok: true, user };
  } catch (e) {
    console.error('verifyInitData error:', e);
    return { ok: false, reason: 'exception' };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { initData, question } = await req.json();
    
    const verification = verifyInitData(initData);
    console.log('[tg-support] verify', {
      initDataLength: initData?.length,
      reason: verification.reason || 'ok',
      user_id: verification.user?.id,
    });

    if (!verification.ok || !verification.user) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!question || question.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'empty_question' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const user = verification.user;
    const telegramId = user.id;

    // Get user profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, first_name, username')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    // Save question to database
    const { data: savedQuestion, error: saveError } = await supabase
      .from('support_questions')
      .insert({
        user_telegram_id: telegramId,
        user_profile_id: profile?.id || null,
        question: question.trim(),
        status: 'pending',
      })
      .select()
      .single();

    if (saveError) {
      console.error('Error saving question:', saveError);
      return new Response(JSON.stringify({ error: 'save_failed' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Saved question:', savedQuestion.id);

    // Send to admin via admin bot with answer button
    const userDisplay = user.username ? `@${user.username}` : `ID:${telegramId}`;
    const userName = user.first_name || profile?.first_name || 'User';

    const adminMessage = `❓ <b>Новый вопрос в поддержку</b>

👤 <b>От:</b> ${userName} (${userDisplay})
🆔 <b>Telegram ID:</b> ${telegramId}

📝 <b>Вопрос:</b>
${question.trim()}`;

    const questionShortId = savedQuestion.id.substring(0, 8);
    const keyboard = {
      inline_keyboard: [
        [{ text: '💬 Ответить', callback_data: `support_answer:${telegramId}:${questionShortId}` }]
      ]
    };

    const adminResponse = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_ADMIN_CHAT_ID,
        text: adminMessage,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }),
    });

    const adminResult = await adminResponse.json();
    console.log('Admin notification result:', adminResult);

    // Save admin message ID
    if (adminResult.ok && adminResult.result?.message_id) {
      await supabase
        .from('support_questions')
        .update({ admin_message_id: adminResult.result.message_id })
        .eq('id', savedQuestion.id);
    }

    return new Response(JSON.stringify({ 
      success: true, 
      questionId: savedQuestion.id 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: 'server_error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
