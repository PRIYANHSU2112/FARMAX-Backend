// Re-exported so every service builds its schema with the SAME Joi instance
// (concat() requires schemas from one Joi version).
export { default as Joi } from 'joi';

export * from './base.schema.js';
export * from './create-config.js';
