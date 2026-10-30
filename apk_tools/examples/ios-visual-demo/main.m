#import <UIKit/UIKit.h>
// Offline visual-only fixture: all painted text and touch targets live in one
// custom view that intentionally exposes no control semantics to accessibility.
@interface BFSCanvas : UIView
@property(nonatomic, copy) NSString *result;
@end
@implementation BFSCanvas
- (instancetype)initWithFrame:(CGRect)frame { if ((self=[super initWithFrame:frame])) { self.backgroundColor=UIColor.whiteColor; self.result=@"RESULT NONE"; self.accessibilityElementsHidden=YES; self.isAccessibilityElement=NO; } return self; }
- (void)drawRect:(CGRect)rect {
 CGFloat w=self.bounds.size.width,h=self.bounds.size.height;
 NSDictionary *attrs=@{NSFontAttributeName:[UIFont boldSystemFontOfSize:30],NSForegroundColorAttributeName:UIColor.blackColor};
 [@"ALPHA" drawAtPoint:CGPointMake(w*.15,h*.27) withAttributes:attrs];
 [@"BETA" drawAtPoint:CGPointMake(w*.15,h*.42) withAttributes:attrs];
 [self.result drawAtPoint:CGPointMake(w*.15,h*.62) withAttributes:attrs];
}
- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
 CGPoint p=[[touches anyObject] locationInView:self]; CGFloat y=p.y/self.bounds.size.height;
 if(y>=.26 && y<.34) self.result=@"RESULT FIRST";
 else if(y>=.41 && y<.49) self.result=@"RESULT SECOND";
 else return;
 [self setNeedsDisplay];
}
@end
@interface BFSDemoController : UIViewController @end
@implementation BFSDemoController
- (void)loadView {self.view=[[BFSCanvas alloc] initWithFrame:UIScreen.mainScreen.bounds];}
- (BOOL)prefersStatusBarHidden {return YES;}
@end
@interface BFSDemoSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic,strong) UIWindow *window;
@end
@implementation BFSDemoSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
 if(![scene isKindOfClass:UIWindowScene.class])return;
 self.window=[[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];self.window.rootViewController=[BFSDemoController new];[self.window makeKeyAndVisible];
}
@end
@interface BFSDemoDelegate : UIResponder <UIApplicationDelegate> @end
@implementation BFSDemoDelegate
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {UISceneConfiguration *c=[[UISceneConfiguration alloc] initWithName:@"Default Configuration" sessionRole:session.role];c.delegateClass=BFSDemoSceneDelegate.class;return c;}
@end
int main(int argc,char *argv[]){@autoreleasepool{return UIApplicationMain(argc,argv,nil,NSStringFromClass(BFSDemoDelegate.class));}}
