const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');

// Store files in memory then push to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (JPEG, PNG, WEBP, GIF)'));
    }
  },
});

// POST /api/uploads/image — upload an image for A/B testing
router.post('/image', authenticate, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const { missionId } = req.body;
    const ext = req.file.mimetype.split('/')[1];
    const filename = `${req.user.id}/${missionId || 'general'}/${Date.now()}.${ext}`;
    const bucket = process.env.STORAGE_BUCKET || 'vettit-uploads';

    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage.from(bucket).getPublicUrl(filename);

    logger.info('Image uploaded', { userId: req.user.id, filename });
    res.json({ url: publicUrl, filename });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/uploads/image — delete an uploaded image
router.delete('/image', authenticate, async (req, res, next) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });

    // Security: ensure user can only delete their own files
    if (!filename.startsWith(req.user.id)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const bucket = process.env.STORAGE_BUCKET || 'vettit-uploads';
    const { error } = await supabase.storage.from(bucket).remove([filename]);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
