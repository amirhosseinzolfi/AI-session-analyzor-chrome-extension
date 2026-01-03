/**
 * Generates a PDF from an HTML element.
 * Captures the exact visual style of the HTML report (Dark Theme) without alterations.
 * Ensures the content fills the PDF page width properly.
 */
async function generateSessionPdf(element, filename) {
  const lib = window.html2pdf;
  
  if (!lib) {
    throw new Error("html2pdf library is not loaded. Ensure html2pdf.bundle.min.js is in the extension folder.");
  }

  // We target the report container to capture the content
  const reportContainer = document.querySelector('.report-container');
  if (!reportContainer) {
    throw new Error("Report container not found");
  }

  const options = {
    // Use zero margins so the dark report background fills the PDF page
    margin: [0, 0, 0, 0],
    filename: filename,
    image: { 
      type: 'jpeg', 
      quality: 0.98 
    },
    html2canvas: { 
      scale: 2, // High resolution
      useCORS: true,
      logging: false,
      scrollY: 0,
      // Force the canvas background to the same dark color as the UI
      backgroundColor: '#212121',
      onclone: (clonedDoc) => {
        // Ensure the cloned document matches the dark theme background end-to-end
        clonedDoc.documentElement.style.background = '#212121';
        clonedDoc.documentElement.style.color = '#ececf1';

        const clonedBody = clonedDoc.body;
        clonedBody.style.background = '#212121';
        clonedBody.style.margin = '0';
        clonedBody.style.padding = '0';
        clonedBody.style.minHeight = '100%';

        const clonedContainer = clonedDoc.querySelector('.report-container');
        
        if (clonedContainer) {
          // CRITICAL: Remove width constraints so it fills the PDF width
          clonedContainer.style.maxWidth = 'none';
          clonedContainer.style.width = '100%';
          clonedContainer.style.margin = '0';
          clonedContainer.style.background = '#2f2f2f';
          
          // Remove shadows/borders that might look weird in print
          clonedContainer.style.boxShadow = 'none';
          clonedContainer.style.border = 'none';
          
          // Ensure height is auto to capture full content
          clonedContainer.style.height = 'auto';
          clonedContainer.style.minHeight = 'auto';
          clonedContainer.style.overflow = 'visible';
        }

        // Hide any UI elements that might have been cloned (if we captured body)
        // or that exist inside the container (like buttons if they were there)
        const elementsToHide = clonedDoc.querySelectorAll('.header-bar, #toast, .btn, button, .actions');
        elementsToHide.forEach(el => el.style.display = 'none');
      }
    },
    jsPDF: { 
      unit: 'mm', 
      format: 'a4', 
      orientation: 'portrait' 
    },
    pagebreak: { 
      mode: ['css', 'legacy'],
      avoid: ['tr', 'blockquote', 'pre', 'li', 'h2', 'h3', '.section-block']
    }
  };

  // Generate PDF from the container
  return lib().set(options).from(reportContainer).save();
}
