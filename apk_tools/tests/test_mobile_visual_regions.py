"""Text extraction uses the same outward integer pixels as approved masks."""
import unittest
from apk_inventory.mobile_visual_workflow import region_text

REGION={'x':.36,'y':.08,'width':.61,'height':.11}

def observed(*tokens):
    return {'width':720,'height':1280,'tokens':[
        {'text':text,'confidence':confidence,'bounds':dict(zip(('x','y','width','height'),box))}
        for text,confidence,box in tokens]}

class PixelRegionTests(unittest.TestCase):
    def test_actual_shanghai_box_on_approved_left_pixel_is_not_false_negative(self):
        self.assertEqual(region_text(observed(('上海',1,(259,136,139,64))),REGION),'上海')

    def test_exact_outward_mask_and_each_inner_edge_are_included(self):
        for box in [(259,102,440,142),(259,120,1,1),(698,120,1,1),(270,102,1,1),(270,243,1,1)]:
            with self.subTest(box=box):
                self.assertEqual(region_text(observed(('北京',.6,box)),REGION),'北京')

    def test_true_left_right_top_bottom_crossing_tokens_are_never_clipped_or_joined(self):
        for box in [(258,120,2,1),(698,120,2,1),(270,101,1,2),(270,243,1,2)]:
            with self.subTest(box=box):
                self.assertEqual(region_text(observed(('跨界',1,box)),REGION),'')

    def test_zero_area_and_below_confidence_remain_excluded(self):
        self.assertEqual(region_text(observed(('低分',.599999,(259,136,139,64))),REGION),'')
        self.assertEqual(region_text(observed(('零宽',1,(259,136,0,64)),('零高',1,(259,136,139,0))),REGION),'')

    def test_text_word_order_and_punctuation_are_not_compacted(self):
        data=observed(('北',1,(260,136,50,64)),('京',1,(315,136,50,64)),('，',1,(370,136,10,64)))
        self.assertEqual(region_text(data,REGION),'北 京 ，')

    def test_scaling_keeps_the_same_integer_containment_semantics(self):
        data={'width':1440,'height':2560,'tokens':[{'text':'上海','confidence':1,'bounds':{'x':518,'y':272,'width':278,'height':128}}]}
        self.assertEqual(region_text(data,REGION),'上海')

if __name__=='__main__':unittest.main()
