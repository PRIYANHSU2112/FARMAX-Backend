import Joi from 'joi';

import { MEDIA_KINDS } from './media.types.js';

/** POST /upload — the file itself is multipart (validated by content, not by Joi). */
export const uploadSchema = {
  querystring: Joi.object({
    type: Joi.string()
      .valid(...MEDIA_KINDS)
      .description('Optional: expected kind. 422 when the file is something else.')
      .meta({ className: 'MediaKind' }),
    purpose: Joi.string()
      .valid('support', 'staff_document', 'wms_document', 'gate_document')
      .description(
        'PRIVATE upload (photo / PDF up to 10 MB, no public URL), returns a signed `receipt`: support = ticket evidence for support-service; staff_document = warehouse staff ID / address proof / photo for warehouse-service (D-56); wms_document = COA, proof of delivery, compliance documents and weigh slips for warehouse-service (D-57); gate_document = gate & weighbridge documents (PO, challan, e-way bill, RC book, permit, insurance, driver licence, weigh slip) for warehouse-service (D-62): up to 25 MB, PDF / JPEG / PNG / TIFF. PDFs are virus-scanned.',
      ),
  }),
};
