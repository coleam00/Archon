# Open source modesl with Groq api and nomic embeddings (local)

If you do not have the hardware to run ollama with open source models, using groqs free tier is a good way to experiment.
The code structure is almost identical as the openai setup in the v1-single-agent parent directory, modified to work with groq api (for open source llms with fast inference and more model choices)

## Additional Features 

- Options to choose different models for summarization and regular LLM model 
    - LLM_MODEL="groq:deepseek-r1-distill-qwen-32b"  (uses this for all agents decision and code generation)
    - SUMMARIZATION_MODEL= "llama-3.3-70b-versatile" (this is used for summarization of the chunks)
    - (change it in the .env file if you need to use different models)
    - note: for the LLM model pydantic_ai supports a subset of models (so all groq models are not supported)
- Added Nomic embeddings (runs on gpu, and in local mode.) (note the embedding does not run asynchronously)
    - uses search_document when generating the embedding from the pydantic docs 
    - uses search_query when embedding the query from the user 
    - using of task specific embedding are found to be better performant 
- Added retry options with a backing off factor on the delay if the rate limit reached for groq free tier 
    - recommend ingesting a few documents at a time to avoid hitting daily rate limit and in an infinite loop of retries


## Prerequisites

- Python 3.11+
- groq
- nomic (for local embedding generation)
- Supabase account and database
- Groq API key
- Streamlit (for web interface)
