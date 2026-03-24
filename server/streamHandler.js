/**
 * Stream Handler
 *
 * Processes SSE event streams from OpenClaw and progressively edits
 * a Telegram message with accumulated text and a typing cursor.
 *
 * Handles Telegram rate limits (~1 edit/sec/message), long message
 * splitting (>3800 chars), and Markdown fallback.
 */

const EDIT_INTERVAL_MS = 1000;
const MAX_MSG_LENGTH = 3800;
const CURSOR = ' ...';

class StreamHandler {
  /**
   * Consume an SSE event stream and progressively update a Telegram message.
   *
   * @param {import('telegraf').Context} ctx
   * @param {AsyncGenerator<{type: string, data: any}>} stream
   * @returns {{ fullText: string, usage: object|null }}
   */
  async handleStream(ctx, stream) {
    let fullText = '';
    let usage = null;
    let messageId = null;
    let lastEditTime = 0;
    let pendingEdit = false;

    const editMessage = async (text, final = false) => {
      const content = final ? text : text + CURSOR;
      if (!content.trim()) return;

      try {
        if (!messageId) {
          const msg = await ctx.reply(content);
          messageId = msg.message_id;
        } else {
          if (final) {
            try {
              await ctx.telegram.editMessageText(
                ctx.chat.id, messageId, null, content,
                { parse_mode: 'Markdown' }
              );
            } catch {
              await ctx.telegram.editMessageText(
                ctx.chat.id, messageId, null, content
              );
            }
          } else {
            await ctx.telegram.editMessageText(
              ctx.chat.id, messageId, null, content
            );
          }
        }
        lastEditTime = Date.now();
        pendingEdit = false;
      } catch (err) {
        if (err.response?.parameters?.retry_after) {
          const wait = err.response.parameters.retry_after * 1000;
          await sleep(wait);
          return editMessage(text, final);
        }
        // "message is not modified" is harmless
      }
    };

    const startNewMessage = async () => {
      if (messageId && fullText.trim()) {
        const segmentText = fullText;
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null, segmentText,
            { parse_mode: 'Markdown' }
          );
        } catch {
          await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null, segmentText
          ).catch(() => {});
        }
      }
      messageId = null;
      fullText = '';
    };

    try {
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          const delta = event.data?.delta || '';
          fullText += delta;

          if (fullText.length > MAX_MSG_LENGTH) {
            const splitIndex = findSplitPoint(fullText, MAX_MSG_LENGTH);
            const segment = fullText.slice(0, splitIndex);
            const remainder = fullText.slice(splitIndex);

            fullText = segment;
            await editMessage(fullText, true);
            await startNewMessage();
            fullText = remainder;
          }

          const now = Date.now();
          if (now - lastEditTime >= EDIT_INTERVAL_MS) {
            await editMessage(fullText);
          } else {
            pendingEdit = true;
          }
        }

        if (event.type === 'response.completed') {
          usage = event.data?.response?.usage || event.data?.usage || null;
        }

        if (event.type === 'response.failed') {
          const errorMsg = event.data?.response?.error?.message
            || event.data?.error?.message
            || 'Unknown streaming error';
          if (messageId) {
            await ctx.telegram.editMessageText(
              ctx.chat.id, messageId, null,
              `❌ ${errorMsg}`
            ).catch(() => {});
          } else {
            await ctx.reply(`❌ ${errorMsg}`);
          }
          return { fullText, usage };
        }
      }
    } catch (err) {
      console.error('[STREAM] Connection error mid-stream:', err.message);
      // Graceful degradation: send whatever we accumulated
    }

    if (fullText.trim()) {
      await editMessage(fullText, true);
    } else if (!messageId) {
      await ctx.reply('(无响应)');
    }

    return { fullText, usage };
  }
}

function findSplitPoint(text, maxLen) {
  let idx = text.lastIndexOf('\n\n', maxLen);
  if (idx !== -1 && idx > maxLen / 2) return idx + 2;
  idx = text.lastIndexOf('. ', maxLen);
  if (idx !== -1 && idx > maxLen / 2) return idx + 2;
  return maxLen;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = StreamHandler;
