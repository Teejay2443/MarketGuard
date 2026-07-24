import os
import sys

def test_ollama():
    print("\n=== Testing Ollama & Gemma 2B ===")
    try:
        import ollama
        print("Ollama Python package is installed.")
        
        # Check if Ollama is running and gemma2:2b is available
        models = ollama.list()
        available_models = [m.model for m in models.models]
        print(f"Available local models: {available_models}")
        
        target_model = "gemma2:2b"
        matching_model = next((m for m in available_models if target_model in m), None)
        
        if not matching_model:
            print(f"[-] WARNING: '{target_model}' is not in your local Ollama models list.")
            print(f"Please run: ollama pull {target_model}")
            return False
            
        print(f"[+] Found matching model: {matching_model}")
        
        # Run a simple test query
        print("Sending test query to Gemma 2B...")
        test_prompt = "I sell two paint rubber of beans to Iya Basira, she pay 15000, she owe 5000. Output raw JSON ONLY."
        response = ollama.chat(
            model=matching_model,
            messages=[{'role': 'user', 'content': test_prompt}]
        )
        print("[+] Gemma response received:")
        print(response['message']['content'].strip())
        return True
    except Exception as e:
        print(f"[-] Ollama test failed: {e}")
        print("Make sure Ollama is installed, running in the background, and you have downloaded gemma2:2b.")
        return False

def test_whisper():
    print("\n=== Testing Whisper STT ===")
    try:
        from faster_whisper import WhisperModel
        print("faster-whisper is installed.")
        
        # Test loading the model (will download and cache if not already done)
        print("Loading Whisper 'tiny' model (this will cache it if run for the first time)...")
        model = WhisperModel("tiny", device="cpu", compute_type="int8")
        print("[+] Whisper model loaded successfully!")
        return True
    except Exception as e:
        print(f"[-] Whisper test failed: {e}")
        return False

if __name__ == "__main__":
    print("Starting diagnostic check for OjaGuard AI dependencies...")
    ollama_ok = test_ollama()
    whisper_ok = test_whisper()
    
    print("\n=== Summary ===")
    print(f"Ollama/Gemma: {'PASSED' if ollama_ok else 'FAILED'}")
    print(f"Whisper STT:  {'PASSED' if whisper_ok else 'FAILED'}")
    
    if ollama_ok and whisper_ok:
        print("\n[+] SUCCESS! All local AI dependencies are fully configured and ready for the hackathon!")
        sys.exit(0)
    else:
        print("\n[-] Please resolve the failed checks above before the hackathon day.")
        sys.exit(1)
