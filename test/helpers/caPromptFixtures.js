/**
 * Creative Attention missions whose prompts were recorded before the
 * placement/market change (test/fixtures/ca_prompts_before.json). None of them
 * carries a placement or market, so the change must reproduce each prompt
 * exactly - with one intended exception, the object-form audience, which used
 * to reach the model as "[object Object]".
 */
const base = {
  user_id: '11111111-1111-4111-8111-111111111111',
  goal_type: 'creative_attention',
  brand_name: 'Almarai',
  brief: 'Launch post for date milk.',
  desired_emotions: ['Trust', 'Joy'],
  key_message: 'Try the new date milk',
};

const CA_PROMPT_FIXTURE_MISSIONS = {
  image_string_audience: {
    ...base, id: 'aaaaaaaa-0000-4000-8000-000000000001', media_type: 'image',
    target_audience: 'Mothers in Saudi',
    brief_attachment: { path: 'u/creative-attention/a.jpg', mimeType: 'image/jpeg' },
  },
  video_string_audience: {
    ...base, id: 'aaaaaaaa-0000-4000-8000-000000000002', media_type: 'video',
    target_audience: 'Luxury fashion consumers, 22-40, GCC + Europe',
    brief_attachment: { path: 'u/creative-attention/a.mp4', mimeType: 'video/mp4' },
  },
  image_no_audience: {
    ...base, id: 'aaaaaaaa-0000-4000-8000-000000000003', media_type: 'image',
    target_audience: null, key_message: null, desired_emotions: null, brief: null,
    brief_attachment: { path: 'u/creative-attention/b.jpg', mimeType: 'image/jpeg' },
  },
  image_object_audience_draft_shape: {
    ...base, id: 'aaaaaaaa-0000-4000-8000-000000000004', media_type: 'image',
    target_audience: { price: '20_50', stage: 'pre_launch', market: 'uae_gulf', clarify: null, suggestions: null },
    brief_attachment: { path: 'u/creative-attention/c.jpg', mimeType: 'image/jpeg' },
  },
};

module.exports = { CA_PROMPT_FIXTURE_MISSIONS };
