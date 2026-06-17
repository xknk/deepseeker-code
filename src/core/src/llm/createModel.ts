import OpenAI from "openai";

export const model = new OpenAI({
    baseURL: process.env.DEEP_SEEK_API_URL || 'https://api.deepseek.com',
    apiKey: process.env.DEEP_SEEK_API_KEY,
});